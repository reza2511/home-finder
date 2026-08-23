import type { SupabaseClient } from "@supabase/supabase-js";
import type { RemovedListing } from "./types";

interface RemovedListingRow {
  source_id: string;
  source_type: RemovedListing["sourceType"];
  external_id: string;
  title: string;
  price: string;
  price_value: number;
  price_range: string | null;
  url: string;
  images: string[] | null;
  main_image: string | null;
  bedrooms: number | null;
  bedroom_type: RemovedListing["bedroomType"];
  bathrooms: number | null;
  parking: number | null;
  floor: number | null;
  tenure: RemovedListing["tenure"];
  is_new_build: boolean;
  postcode: string | null;
  area: string | null;
  removed_at: string;
}

// Same pagination approach as lib/listingsQuery.ts's fetchAllActiveListingRows
// — PostgREST caps a single request at its own db-max-rows ceiling (1000 by
// default) regardless of what's asked for, so this pages through until a
// short page confirms there's nothing left, rather than silently truncating
// once the removed-listings total grows past that.
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

async function fetchRemovedListingRows(
  client: SupabaseClient,
  sinceIso: string
): Promise<{ rows: RemovedListingRow[]; error: string | null }> {
  const rows: RemovedListingRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await client
      .from("listings")
      .select(
        "source_id, source_type, external_id, title, price, price_value, price_range, url, images, main_image, bedrooms, bedroom_type, bathrooms, parking, floor, tenure, is_new_build, postcode, area, removed_at"
      )
      .eq("active", false)
      .not("removed_at", "is", null)
      .gte("removed_at", sinceIso)
      .order("removed_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
      .returns<RemovedListingRow[]>();
    if (error) return { rows, error: error.message };

    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { rows, error: null };
}

/**
 * Every listing marked removed (active = false) since `sinceIso`, most
 * recently removed first — the query behind GET /api/removed and the
 * public Removed items page. `removed_at` is only ever set going forward
 * from supabase/migrations/0008_add_listing_removed_at.sql, so a listing
 * that went inactive before that migration ran (removed_at still null) is
 * correctly excluded rather than shown with a guessed date — see that
 * migration's own comment for why.
 */
export async function fetchRemovedListings(
  client: SupabaseClient,
  sinceIso: string
): Promise<{ listings: RemovedListing[]; error: string | null }> {
  const [{ rows, error: listingsErr }, { data: sources, error: statusErr }] = await Promise.all([
    fetchRemovedListingRows(client, sinceIso),
    client.from("sync_status").select("source_id, source_name").returns<{ source_id: string; source_name: string }[]>(),
  ]);

  if (listingsErr) {
    return { listings: [], error: `Failed to read removed listings from Supabase: ${listingsErr}` };
  }
  if (statusErr) {
    return { listings: [], error: `Failed to read sync_status from Supabase: ${statusErr.message}` };
  }

  const sourceNameById = new Map((sources ?? []).map((s) => [s.source_id, s.source_name]));

  const listings: RemovedListing[] = rows.map((r) => ({
    sourceId: r.source_id,
    sourceName: sourceNameById.get(r.source_id) ?? r.source_id,
    sourceType: r.source_type,
    externalId: r.external_id,
    title: r.title,
    price: r.price,
    priceValue: r.price_value,
    priceRange: r.price_range,
    url: r.url,
    images: r.images ?? [],
    mainImage: r.main_image,
    bedrooms: r.bedrooms,
    bedroomType: r.bedroom_type,
    bathrooms: r.bathrooms,
    parking: r.parking,
    floor: r.floor,
    tenure: r.tenure,
    isNewBuild: r.is_new_build,
    postcode: r.postcode ?? "",
    area: r.area ?? "",
    removedAt: r.removed_at,
  }));

  return { listings, error: null };
}
