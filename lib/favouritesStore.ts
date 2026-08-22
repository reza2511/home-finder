/**
 * Private favourites for the app's single operator account — see
 * supabase/migrations/0006_favourites.sql for why `user_id` is a fixed
 * string rather than a real per-user identifier (this app has one login,
 * not per-user Supabase Auth accounts).
 *
 * Every function here uses the service_role client and is only ever called
 * from a route that's already checked isAuthenticated() (app/api/
 * favourites/*) — there's no public RLS policy on either table, so this is
 * genuinely the only access path, not just an app-level nicety layered on
 * top of already-public data (contrast with refresh history, which is
 * deliberately public).
 */
import { requireSupabaseAdmin } from "./db";
import type { Listing } from "./types";

export const FIXED_USER_ID = "reza"; // the one account lib/auth.ts ever authenticates
export const MAX_KEPT_REMOVALS = 20;

export interface FavouriteRemoval {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  url: string;
  removedAt: string;
}

interface ListingRow {
  source_id: string;
  source_type: Listing["sourceType"];
  external_id: string;
  title: string;
  price: string;
  price_value: number;
  price_range: string | null;
  url: string;
  images: string[] | null;
  main_image: string | null;
  bedrooms: number | null;
  bedroom_type: Listing["bedroomType"];
  tenure: Listing["tenure"];
  is_new_build: boolean;
  postcode: string | null;
  area: string | null;
}

/** Every currently-favourited listing's full details, most recently
 * favourited first. A favourite whose listing has since gone inactive
 * during a sync is never kept around in `favourites` at all — see
 * recordRemovedFavourites below, called right when that happens — so
 * everything this returns is guaranteed to still be a real, live listing. */
export async function listFavourites(): Promise<Listing[]> {
  const admin = requireSupabaseAdmin();

  const { data: favRows, error: favErr } = await admin
    .from("favourites")
    .select("source_id, external_id")
    .eq("user_id", FIXED_USER_ID)
    .order("created_at", { ascending: false })
    .returns<{ source_id: string; external_id: string }[]>();
  if (favErr) {
    throw new Error(`listFavourites: failed to read favourites: ${favErr.message}`);
  }
  if (!favRows || favRows.length === 0) return [];

  // external_id is only unique *within* a source (two different developers
  // can both use "plot-1"), so matching favourites to listings needs the
  // real (source_id, external_id) pair, not a bare `.in("external_id", …)`
  // — that would wrongly pull in a same-numbered listing from an unrelated
  // source. PostgREST's `.or()` with comma-separated `and(...)` groups is
  // the way to express a tuple-IN filter.
  //
  // Preserve favourited-order (most recent first) afterwards — a filtered
  // query like this doesn't guarantee row order, so look each one up in a
  // map rather than trusting the listings query's own order.
  const pairFilter = favRows
    .map((f) => `and(source_id.eq.${f.source_id},external_id.eq.${f.external_id})`)
    .join(",");
  const [{ data: sourceNames, error: statusErr }, { data: listingRows, error: listingsErr }] = await Promise.all([
    admin.from("sync_status").select("source_id, source_name").returns<{ source_id: string; source_name: string }[]>(),
    admin
      .from("listings")
      .select(
        "source_id, source_type, external_id, title, price, price_value, price_range, url, images, main_image, bedrooms, bedroom_type, tenure, is_new_build, postcode, area"
      )
      .eq("active", true)
      .or(pairFilter)
      .returns<ListingRow[]>(),
  ]);
  if (statusErr) throw new Error(`listFavourites: failed to read sync_status: ${statusErr.message}`);
  if (listingsErr) throw new Error(`listFavourites: failed to read listings: ${listingsErr.message}`);

  const sourceNameById = new Map((sourceNames ?? []).map((s) => [s.source_id, s.source_name]));
  const listingByKey = new Map(
    (listingRows ?? []).map((r) => [`${r.source_id}::${r.external_id}`, r])
  );

  const listings: Listing[] = [];
  for (const fav of favRows) {
    const row = listingByKey.get(`${fav.source_id}::${fav.external_id}`);
    if (!row) continue; // favourited but not currently active/found — shouldn't happen, see file header; skip rather than fabricate
    listings.push({
      sourceId: row.source_id,
      sourceName: sourceNameById.get(row.source_id) ?? row.source_id,
      sourceType: row.source_type,
      externalId: row.external_id,
      title: row.title,
      price: row.price,
      priceValue: row.price_value,
      priceRange: row.price_range,
      url: row.url,
      images: row.images ?? [],
      mainImage: row.main_image,
      bedrooms: row.bedrooms,
      bedroomType: row.bedroom_type,
      tenure: row.tenure,
      isNewBuild: row.is_new_build,
      postcode: row.postcode ?? "",
      area: row.area ?? "",
    });
  }
  return listings;
}

/** Just the `sourceId::externalId` keys, for the heart icon on every card
 * to know which listings are currently favourited without fetching each
 * one's full details. */
export async function listFavouriteKeys(): Promise<string[]> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("favourites")
    .select("source_id, external_id")
    .eq("user_id", FIXED_USER_ID)
    .returns<{ source_id: string; external_id: string }[]>();
  if (error) throw new Error(`listFavouriteKeys: read failed: ${error.message}`);
  return (data ?? []).map((r) => `${r.source_id}::${r.external_id}`);
}

/** Idempotent — favouriting an already-favourited listing is a no-op, not
 * an error (upsert on the table's own unique (user_id, source_id,
 * external_id) constraint). Only succeeds for a listing that's genuinely
 * currently active — never lets you favourite something that doesn't
 * really exist. */
export async function addFavourite(sourceId: string, externalId: string): Promise<void> {
  const admin = requireSupabaseAdmin();

  const { data: listing, error: findErr } = await admin
    .from("listings")
    .select("source_id")
    .eq("source_id", sourceId)
    .eq("external_id", externalId)
    .eq("active", true)
    .maybeSingle();
  if (findErr) throw new Error(`addFavourite: lookup failed: ${findErr.message}`);
  if (!listing) throw new Error("That listing doesn't exist or is no longer active.");

  const { error } = await admin
    .from("favourites")
    .upsert(
      { user_id: FIXED_USER_ID, source_id: sourceId, external_id: externalId },
      { onConflict: "user_id,source_id,external_id" }
    );
  if (error) throw new Error(`addFavourite: insert failed: ${error.message}`);
}

export async function removeFavourite(sourceId: string, externalId: string): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { error } = await admin
    .from("favourites")
    .delete()
    .eq("user_id", FIXED_USER_ID)
    .eq("source_id", sourceId)
    .eq("external_id", externalId);
  if (error) throw new Error(`removeFavourite: delete failed: ${error.message}`);
}

interface RemovalRow {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  url: string;
  removed_at: string;
}

export async function listRecentRemovals(): Promise<FavouriteRemoval[]> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("favourite_removals")
    .select("id, source_id, external_id, title, url, removed_at")
    .eq("user_id", FIXED_USER_ID)
    .order("removed_at", { ascending: false })
    .limit(MAX_KEPT_REMOVALS)
    .returns<RemovalRow[]>();
  if (error) throw new Error(`listRecentRemovals: read failed: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    externalId: r.external_id,
    title: r.title,
    url: r.url,
    removedAt: r.removed_at,
  }));
}

/**
 * Called from lib/listingsStore.ts's upsertListingsForSource right after a
 * batch of listings is marked inactive during a sync. For any of those that
 * were favourited: records a removal notification (title/url as they were
 * at removal time — the `listings` row is only soft-removed, but this stays
 * meaningful even if that ever changes) and un-favourites it, since
 * listFavourites() only ever shows currently-active listings. Best-effort:
 * a failure here is logged, not thrown — a sync's real listings work should
 * never fail because of this bookkeeping.
 */
export async function recordRemovedFavourites(
  sourceId: string,
  removed: { externalId: string; title: string; url: string }[]
): Promise<void> {
  if (removed.length === 0) return;
  try {
    const admin = requireSupabaseAdmin();

    const { data: favRows, error: favErr } = await admin
      .from("favourites")
      .select("external_id")
      .eq("user_id", FIXED_USER_ID)
      .eq("source_id", sourceId)
      .in(
        "external_id",
        removed.map((r) => r.externalId)
      )
      .returns<{ external_id: string }[]>();
    if (favErr) throw new Error(`read favourites failed: ${favErr.message}`);

    const favouritedIds = new Set((favRows ?? []).map((r) => r.external_id));
    const removedFavourites = removed.filter((r) => favouritedIds.has(r.externalId));
    if (removedFavourites.length === 0) return;

    const { error: insertErr } = await admin.from("favourite_removals").insert(
      removedFavourites.map((r) => ({
        user_id: FIXED_USER_ID,
        source_id: sourceId,
        external_id: r.externalId,
        title: r.title,
        url: r.url,
      }))
    );
    if (insertErr) throw new Error(`insert favourite_removals failed: ${insertErr.message}`);

    const { error: deleteErr } = await admin
      .from("favourites")
      .delete()
      .eq("user_id", FIXED_USER_ID)
      .eq("source_id", sourceId)
      .in(
        "external_id",
        removedFavourites.map((r) => r.externalId)
      );
    if (deleteErr) throw new Error(`un-favouriting removed listings failed: ${deleteErr.message}`);

    await pruneOldRemovals();

    console.warn(
      `[favouritesStore] ${sourceId}: recorded ${removedFavourites.length} favourite removal(s): ${removedFavourites.map((r) => r.title).join(", ")}`
    );
  } catch (err) {
    console.warn(`[favouritesStore] recordRemovedFavourites(${sourceId}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Keeps only the MAX_KEPT_REMOVALS most recent removal notifications. */
async function pruneOldRemovals(): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { data: keep, error: keepErr } = await admin
    .from("favourite_removals")
    .select("id")
    .eq("user_id", FIXED_USER_ID)
    .order("removed_at", { ascending: false })
    .limit(MAX_KEPT_REMOVALS)
    .returns<{ id: string }[]>();
  if (keepErr) throw new Error(`pruneOldRemovals: read failed: ${keepErr.message}`);

  const keepIds = (keep ?? []).map((r) => r.id);
  if (keepIds.length === 0) return;

  const { error: deleteErr } = await admin
    .from("favourite_removals")
    .delete()
    .eq("user_id", FIXED_USER_ID)
    .not("id", "in", `(${keepIds.join(",")})`);
  if (deleteErr) throw new Error(`pruneOldRemovals: delete failed: ${deleteErr.message}`);
}
