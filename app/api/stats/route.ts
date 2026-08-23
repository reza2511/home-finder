import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { fetchActiveListings } from "@/lib/listingsQuery";
import { fetchDailyStats } from "@/lib/statsQuery";
import { summarizeBySource } from "@/lib/sourceBreakdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, read-only — no isAuthenticated() gate, same as GET /api/listings
// and GET /api/removed. "Total currently listed" and "per source" are
// computed live from `listings` (not the last daily snapshot, which can be
// up to a day stale) so the headline number is always exactly right now;
// `daily` is the accumulating history from stats_daily_snapshots
// (lib/statsStore.ts), for the trend charts.
export async function GET() {
  const [{ listings, error: listingsErr }, { daily, error: dailyErr }] = await Promise.all([
    fetchActiveListings(supabase),
    fetchDailyStats(supabase),
  ]);

  if (listingsErr) {
    return NextResponse.json({ error: listingsErr }, { status: 500 });
  }
  if (dailyErr) {
    return NextResponse.json({ error: dailyErr }, { status: 500 });
  }

  const bySource = summarizeBySource(listings).sort((a, b) => b.listingCount - a.listingCount);

  return NextResponse.json({
    totalCurrent: listings.length,
    bySource,
    daily,
  });
}
