import type { SupabaseClient } from "@supabase/supabase-js";
import { findNearestStation } from "./nearestStation";
import type { Listing } from "./types";

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
  bathrooms: number | null;
  parking: number | null;
  floor: number | null;
  tenure: Listing["tenure"];
  is_new_build: boolean;
  postcode: string | null;
  area: string | null;
  lat: number | null;
  lng: number | null;
}

// This used to request an explicit, generous `.range(0, 4999)` in one shot,
// on the theory that a single request asking for more than the current
// total would return everything. That's wrong on Supabase specifically:
// PostgREST enforces its own server-side `db-max-rows` ceiling (1000 by
// default) that silently caps the response — confirmed live once the
// dataset actually grew past it (1,244 active listings; the aggregator
// adapters alone add 700+): the exact same class of bug this endpoint's
// hardcoded `LIMIT 200` caused against SQLite (see git history), just
// resurfacing at a different, platform-imposed ceiling instead of a
// hand-rolled one. A single `.range()` can only ever ask the server for up
// to whatever that ceiling is; it can't override it. The real fix is to
// page through in a loop, one request per `PAGE_SIZE`-sized chunk, until a
// page comes back with fewer rows than requested — that terminates
// correctly regardless of what the server's own cap is set to, so this can
// never again silently drop listings just because the total grew past some
// number nobody explicitly chose.
const PAGE_SIZE = 1000;
const MAX_PAGES = 20; // 20,000 rows — comfortably beyond any realistic total; a real, generous safety net, not a silent cap

async function fetchAllActiveListingRows(
  client: SupabaseClient
): Promise<{ rows: ListingRow[]; error: string | null }> {
  const rows: ListingRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await client
      .from("listings")
      .select(
        "source_id, source_type, external_id, title, price, price_value, price_range, url, images, main_image, bedrooms, bedroom_type, bathrooms, parking, floor, tenure, is_new_build, postcode, area, lat, lng"
      )
      .eq("active", true)
      .order("last_seen_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
      .returns<ListingRow[]>();
    if (error) return { rows, error: error.message };

    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break; // short page — this was the last one
  }
  return { rows, error: null };
}

/**
 * Every currently-active listing, joined with sync_status for each source's
 * display name, in the app's canonical `Listing` shape. Shared by GET
 * /api/listings (the live feed) and the refresh-history snapshot capture
 * (lib/historyStore.ts) so both produce byte-identical listing objects —
 * a recalled snapshot renders through the exact same components as live
 * data, no separate mapping to keep in sync.
 *
 * `listings` and `sync_status` share a source_id column but have no foreign
 * key between them (see supabase/migrations/0001_init.sql), so PostgREST
 * can't embed one in the other via a single `.select()` — two queries plus
 * an in-memory merge, same shape a SQL LEFT JOIN would produce.
 */
export async function fetchActiveListings(
  client: SupabaseClient
): Promise<{ listings: Listing[]; error: string | null }> {
  const [{ rows, error: listingsErr }, { data: sources, error: statusErr }] = await Promise.all([
    fetchAllActiveListingRows(client),
    client.from("sync_status").select("source_id, source_name").returns<{ source_id: string; source_name: string }[]>(),
  ]);

  if (listingsErr) {
    return { listings: [], error: `Failed to read listings from Supabase: ${listingsErr}` };
  }
  if (statusErr) {
    return { listings: [], error: `Failed to read sync_status from Supabase: ${statusErr.message}` };
  }

  const sourceNameById = new Map((sources ?? []).map((s) => [s.source_id, s.source_name]));

  const listings: Listing[] = rows.map((r) => ({
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
    lat: r.lat,
    lng: r.lng,
    // Real distance to the real nearest station (lib/nearestStation.ts),
    // only when this listing has real coordinates — never guessed.
    nearestStation: r.lat != null && r.lng != null ? findNearestStation({ lat: r.lat, lng: r.lng }) : null,
  }));

  return { listings, error: null };
}
