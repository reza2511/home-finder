import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ListingRow {
  source_id: string;
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

// Aggregated feed of currently-active listings across every source, for the
// main page grid. Not part of the status monitor feature, but gives the app
// something to show behind it.
//
// No row cap requested here beyond an explicit, generous `.range()`: this
// endpoint used to cap at a hardcoded LIMIT 200 (ORDER BY lastSeenAt DESC),
// which silently dropped every listing from whichever sources happened to
// have synced least recently — with enough total listings across sources,
// an entire developer's listings could be cut from this response and never
// reach the client at all (see git history). AppShell's per-developer
// `counts` (and so the left-hand developer filter, which hides any
// developer with a 0 count) are derived straight from this response, so
// that truncation also erased whole developers from the sidebar even though
// they had real, active listings. The dataset here is a bounded, curated
// list of London developers — not an open-ended feed — so an explicit range
// well above the current total (a few hundred rows) is the correct fix,
// rather than relying on PostgREST's own default row cap (commonly 1000)
// and risking the same silent-truncation bug again unnoticed.
const MAX_LISTINGS = 5000;

// `listings` and `sync_status` share a source_id column but have no foreign
// key between them (see supabase/migrations/0001_init.sql), so PostgREST
// can't embed one in the other via a single `.select()` — two queries plus
// an in-memory merge, same shape the old SQL LEFT JOIN produced.
export async function GET() {
  const [{ data: rows, error: listingsErr }, { data: sources, error: statusErr }] = await Promise.all([
    supabase
      .from("listings")
      .select(
        "source_id, external_id, title, price, price_value, price_range, url, images, main_image, bedrooms, bedroom_type, tenure, is_new_build, postcode, area"
      )
      .eq("active", true)
      .order("last_seen_at", { ascending: false })
      .range(0, MAX_LISTINGS - 1)
      .returns<ListingRow[]>(),
    supabase.from("sync_status").select("source_id, source_name").returns<{ source_id: string; source_name: string }[]>(),
  ]);

  if (listingsErr) {
    return NextResponse.json({ error: `Failed to read listings from Supabase: ${listingsErr.message}` }, { status: 500 });
  }
  if (statusErr) {
    return NextResponse.json({ error: `Failed to read sync_status from Supabase: ${statusErr.message}` }, { status: 500 });
  }

  const sourceNameById = new Map((sources ?? []).map((s) => [s.source_id, s.source_name]));

  const listings: Listing[] = (rows ?? []).map((r) => ({
    sourceId: r.source_id,
    sourceName: sourceNameById.get(r.source_id) ?? r.source_id,
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
    tenure: r.tenure,
    isNewBuild: r.is_new_build,
    postcode: r.postcode ?? "",
    area: r.area ?? "",
  }));

  return NextResponse.json({ listings });
}
