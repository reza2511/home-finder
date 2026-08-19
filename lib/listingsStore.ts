import { requireSupabaseAdmin } from "./db";
import type { AdapterListing } from "./adapters/types";

export interface DiffResult {
  added: number;
  updated: number;
  removed: number;
}

interface ExistingRow {
  external_id: string;
  active: boolean;
}

/**
 * Upserts a source's freshly-fetched listings into Supabase and diffs them
 * against what was previously active for that source. Any previously-active
 * listing not present in `incoming` is marked inactive ("removed"). A
 * listing seen again (present both before and after) counts as "updated" —
 * this is a simple re-seen count, not a field-level change diff.
 *
 * Writes via the service_role client (requireSupabaseAdmin) since RLS has
 * no anon/authenticated insert or update policy on `listings` — see
 * supabase/migrations/0001_init.sql.
 */
export async function upsertListingsForSource(
  sourceId: string,
  incoming: AdapterListing[]
): Promise<DiffResult> {
  const admin = requireSupabaseAdmin();

  const { data: existingRows, error: fetchErr } = await admin
    .from("listings")
    .select("external_id, active")
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

  if (incoming.length > 0) {
    const now = new Date().toISOString();
    const rows = incoming.map((listing) => ({
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
      tenure: listing.tenure,
      is_new_build: listing.isNewBuild,
      postcode: listing.postcode,
      area: listing.area,
      last_seen_at: now,
      active: true,
      // first_seen_at deliberately omitted from every row: on INSERT the
      // column's own `default now()` fills it; on UPDATE (conflict),
      // leaving it out of the payload means the ON CONFLICT DO UPDATE
      // Postgres generates never touches that column, so a listing's
      // original first-seen timestamp survives every re-sync rather than
      // being reset just because it was seen again.
    }));

    const { error: upsertErr } = await admin
      .from("listings")
      .upsert(rows, { onConflict: "source_id,external_id" });
    if (upsertErr) {
      throw new Error(`upsertListingsForSource(${sourceId}): upsert failed: ${upsertErr.message}`);
    }
  }

  const incomingIds = new Set(incoming.map((l) => l.externalId));
  const toRemove = [...activeIds].filter((id) => !incomingIds.has(id));
  if (toRemove.length > 0) {
    const { error: removeErr } = await admin
      .from("listings")
      .update({ active: false })
      .eq("source_id", sourceId)
      .in("external_id", toRemove);
    if (removeErr) {
      throw new Error(`upsertListingsForSource(${sourceId}): failed to mark removed listings inactive: ${removeErr.message}`);
    }
  }

  return { added, updated, removed: toRemove.length };
}
