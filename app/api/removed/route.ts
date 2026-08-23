import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { fetchRemovedListings } from "@/lib/removedListingsQuery";
import { MAX_REMOVED_TIME_RANGE_DAYS, removedTimeRangeCutoff } from "@/lib/removedTimeRanges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, read-only — no isAuthenticated() gate. Uses the anon `supabase`
// client (same as GET /api/listings), which is all that's needed: the
// listings table has an unconditional public-SELECT RLS policy (see
// supabase/migrations/0001_init.sql), so this was already just as readable
// as active listings, just never queried this way before.
//
// Fetches everything removed within the widest range the Removed items
// page's filter offers (3 months) in one request; the page itself narrows
// that down to whichever range is currently selected — same
// fetch-once-filter-client-side pattern AppShell uses for the live grid.
export async function GET() {
  const sinceIso = removedTimeRangeCutoff(MAX_REMOVED_TIME_RANGE_DAYS).toISOString();
  const { listings, error } = await fetchRemovedListings(supabase, sinceIso);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  return NextResponse.json({ listings });
}
