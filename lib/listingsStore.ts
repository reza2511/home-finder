import { requireSupabaseAdmin } from "./db";
import { recordRemovedFavourites } from "./favouritesStore";
import { geocodePostcodes } from "./geocoding";
import { DROP_GUARD_THRESHOLD_PERCENT, evaluateDropGuard, logSyncEvent, setDropGuardFlag } from "./dropGuard";
import type { AdapterListing } from "./adapters/types";
import type { SourceType } from "./types";

export interface DiffResult {
  added: number;
  updated: number;
  removed: number;
  /** True when this source HAD a real, non-empty candidate removal, but
   * the site-wide drop guard (lib/dropGuard.ts) rejected it as abnormal —
   * `removed` is 0 in that case not because nothing looked gone, but
   * because applying it was refused. See lib/syncEngine.ts's runOne,
   * which surfaces this on the source's sync_status row. */
  dropGuardTriggered: boolean;
}

interface ExistingRow {
  external_id: string;
  active: boolean;
  title: string;
  url: string;
}

/**
 * Upserts a source's freshly-fetched listings into Supabase and diffs them
 * against what was previously active for that source. Any previously-active
 * listing not present in `incoming` is marked inactive ("removed") and
 * stamped with `removed_at` — the moment this run first noticed it was
 * gone, which is what the public Removed items page (lib/removedListingsQuery.ts)
 * sorts and filters by. A listing seen again (present both before and
 * after) counts as "updated" — this is a simple re-seen count, not a
 * field-level change diff.
 *
 * 2026-08-25: `incoming` being empty used to still run the full removal
 * diff — `toRemove` came out as literally every currently-active row for
 * this source, so a source adapter that ran without throwing but happened
 * to find zero listings (a transient empty response, a page-structure
 * change the adapter's own parsing didn't notice, a momentary block that
 * didn't trip its error path) silently wiped that source's entire active
 * set in one call. A real 0-result run IS possible (a source genuinely
 * having nothing live right now), but there is no way from here to tell
 * that apart from an adapter quietly returning nothing it shouldn't have —
 * and the cost of wrongly keeping a handful of truly-gone listings around
 * a little longer is far smaller than the cost of wrongly nuking an entire
 * source's real listings. So: the removal diff now only ever runs when
 * `incoming` is non-empty — a 0-result run leaves every previously-active
 * listing for this source untouched (not removed), same as a source that
 * fails outright already does one level up (lib/syncEngine.ts's runOne
 * never calls this function at all when adapter.run() throws).
 *
 * 2026-08-25: a second, independent safety net on top of the above — even
 * a genuinely non-empty `incoming` can still produce a `toRemove` set that
 * would be abnormally large relative to the whole site (a source's own
 * parsing silently breaking and returning a real-looking but tiny subset
 * of its true listings, a page only partially loading before the adapter
 * gave up, etc.). Before any removal is actually applied, lib/dropGuard.ts's
 * evaluateDropGuard() checks what applying it would do to the SITE-WIDE
 * active total — if that drop exceeds DROP_GUARD_THRESHOLD_PERCENT, the
 * removal is rejected wholesale (every one of `toRemove`, not a partial
 * application), the existing listings are left exactly as they were, and
 * the rejection is logged both to sync_events_log (an audit trail) and
 * sync_health (a persistent "needs attention" flag) — see that module's
 * own doc comments. This never happens automatically-and-silently-clears:
 * a human has to acknowledge it (POST /api/health/acknowledge).
 *
 * Writes via the service_role client (requireSupabaseAdmin) since RLS has
 * no anon/authenticated insert or update policy on `listings` — see
 * supabase/migrations/0001_init.sql.
 *
 * A listing going inactive that was favourited also gets recorded as a
 * removal notification (lib/favouritesStore.ts's recordRemovedFavourites)
 * and un-favourited — see that function's own doc comment.
 */
export async function upsertListingsForSource(
  sourceId: string,
  incoming: AdapterListing[],
  sourceType: SourceType = "developer"
): Promise<DiffResult> {
  const admin = requireSupabaseAdmin();

  const { data: existingRows, error: fetchErr } = await admin
    .from("listings")
    .select("external_id, active, title, url")
    .eq("source_id", sourceId)
    .returns<ExistingRow[]>();
  if (fetchErr) {
    throw new Error(`upsertListingsForSource(${sourceId}): failed to read existing rows: ${fetchErr.message}`);
  }

  // Active-set membership (not mere row existence) is what "added" vs
  // "updated" means for reporting — mirrors the app's previous SQLite
  // semantics, where a previously soft-removed listing reappearing counts
  // as "added" again even though the row itself never stopped existing.
  const activeIds = new Set((existingRows ?? []).filter((r) => r.active).map((r) => r.external_id));

  let added = 0;
  let updated = 0;
  for (const listing of incoming) {
    if (activeIds.has(listing.externalId)) updated += 1;
    else added += 1;
  }

  // Shared across both the upsert below and the removal update further
  // down, so a listing added AND another removed in the same sync call get
  // the exact same timestamp rather than two clock reads a moment apart.
  const now = new Date().toISOString();

  if (incoming.length > 0) {
    // Real coordinates, derived from each listing's own real postcode via
    // postcodes.io (lib/geocoding.ts) — never invented. A postcode that
    // doesn't resolve (or is blank) just means that listing gets no
    // coordinates, same as any other "source doesn't state it" field here.
    const coordsByPostcode = await geocodePostcodes(incoming.map((l) => l.postcode).filter(Boolean));

    const rows = incoming.map((listing) => {
      const coords = listing.postcode ? coordsByPostcode.get(listing.postcode.trim()) : undefined;
      return {
        source_id: sourceId,
        external_id: listing.externalId,
        title: listing.title,
        price: listing.price,
        price_value: listing.priceValue,
        price_range: listing.priceRange ?? null,
        url: listing.url,
        images: listing.images ?? [],
        main_image: listing.mainImage,
        bedrooms: listing.bedrooms,
        bedroom_type: listing.bedroomType,
        bathrooms: listing.bathrooms ?? null,
        parking: listing.parking ?? null,
        floor: listing.floor ?? null,
        tenure: listing.tenure,
        is_new_build: listing.isNewBuild,
        postcode: listing.postcode,
        area: listing.area,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        source_type: sourceType,
        last_seen_at: now,
        active: true,
        // A listing that reappears after previously going inactive is no
        // longer "removed" — clear any removed_at it was carrying so it
        // doesn't linger on the Removed items page.
        removed_at: null,
        // first_seen_at deliberately omitted from every row: on INSERT the
        // column's own `default now()` fills it; on UPDATE (conflict),
        // leaving it out of the payload means the ON CONFLICT DO UPDATE
        // Postgres generates never touches that column, so a listing's
        // original first-seen timestamp survives every re-sync rather than
        // being reset just because it was seen again.
      };
    });

    const { error: upsertErr } = await admin
      .from("listings")
      .upsert(rows, { onConflict: "source_id,external_id" });
    if (upsertErr) {
      throw new Error(`upsertListingsForSource(${sourceId}): upsert failed: ${upsertErr.message}`);
    }
  }

  const incomingIds = new Set(incoming.map((l) => l.externalId));
  // See this function's own doc comment: never diff a removal set out of an
  // empty `incoming` — that would mean "found nothing" and "genuinely gone"
  // are treated identically, which is exactly the failure mode being
  // guarded against here.
  let toRemove =
    incoming.length > 0 ? [...activeIds].filter((id) => !incomingIds.has(id)) : [];

  let dropGuardTriggered = false;
  if (toRemove.length > 0) {
    const guard = await evaluateDropGuard(toRemove.length);
    if (!guard.allowed) {
      dropGuardTriggered = true;
      const message =
        `Sync rejected — abnormal drop of ${guard.dropPercent.toFixed(1)}%, listings preserved ` +
        `(source: ${sourceId}, would-remove ${guard.candidateRemovedCount} of ${guard.previousActiveTotal} ` +
        `site-wide active listings, threshold ${DROP_GUARD_THRESHOLD_PERCENT}%)`;
      console.warn(`[dropGuard] ${message}`);
      // Fire-and-record in parallel: neither write should block or fail the
      // other, and either failing is already best-effort/non-fatal on its
      // own (see logSyncEvent/setDropGuardFlag's own comments) — the actual
      // protection (not applying `toRemove` below) doesn't depend on either
      // succeeding.
      await Promise.all([
        logSyncEvent("drop_guard_rejected", sourceId, message, {
          previousActiveTotal: guard.previousActiveTotal,
          candidateRemovedCount: guard.candidateRemovedCount,
          dropPercent: guard.dropPercent,
          thresholdPercent: DROP_GUARD_THRESHOLD_PERCENT,
        }),
        setDropGuardFlag(message),
      ]);
      // Do NOT apply the mass removal — every previously-active listing for
      // this source stays exactly as it was.
      toRemove = [];
    }
  }

  if (toRemove.length > 0) {
    const { error: removeErr } = await admin
      .from("listings")
      .update({ active: false, removed_at: now })
      .eq("source_id", sourceId)
      .in("external_id", toRemove);
    if (removeErr) {
      throw new Error(`upsertListingsForSource(${sourceId}): failed to mark removed listings inactive: ${removeErr.message}`);
    }

    // If any of these were favourited, record a removal notification and
    // un-favourite them (lib/favouritesStore.ts) — best-effort, never lets
    // this fail the sync itself. title/url are each row's real, last-known
    // values (read above, before this update touched anything but
    // `active`), not guessed.
    const existingByExternalId = new Map((existingRows ?? []).map((r) => [r.external_id, r]));
    await recordRemovedFavourites(
      sourceId,
      toRemove.map((externalId) => {
        const row = existingByExternalId.get(externalId)!;
        return { externalId, title: row.title, url: row.url };
      })
    );
  }

  return { added, updated, removed: toRemove.length, dropGuardTriggered };
}
