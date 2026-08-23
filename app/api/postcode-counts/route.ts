import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { fetchActiveListings } from "@/lib/listingsQuery";
import { extractDistrictCode } from "@/lib/postcodeDistricts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, read-only — no isAuthenticated() gate, same as GET /api/listings.
// Returns real listing counts per postcode DISTRICT (e.g. "NW9", "SW20"),
// computed server-side from every currently-active listing, so the
// Postcode Map page only has to fetch a small { code: count } object
// instead of all ~1,400 full listing records just to count them by
// postcode. A listing with no postcode, or one that doesn't parse as a
// real UK outward code (lib/postcodeDistricts.ts's extractDistrictCode),
// simply isn't counted anywhere — never guessed at.
export async function GET() {
  const { listings, error } = await fetchActiveListings(supabase);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  const counts: Record<string, number> = {};
  for (const listing of listings) {
    if (!listing.postcode) continue;
    const district = extractDistrictCode(listing.postcode);
    if (!district) continue;
    counts[district] = (counts[district] ?? 0) + 1;
  }

  return NextResponse.json({ counts });
}
