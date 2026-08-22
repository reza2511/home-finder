import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import type { SourceBreakdownEntry } from "@/lib/historyStore";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SnapshotRow {
  id: string;
  captured_at: string;
  listing_count: number;
  listings: Listing[];
  sources: SourceBreakdownEntry[] | null;
  sync_runs: { started_at: string } | null;
}

// Public — recalling a past snapshot is for everyone, same as GET
// /api/listings. Reads via the anon client, subject to the public SELECT
// RLS policy on both tables (see supabase/migrations/
// 0005_history_public_and_source_breakdown.sql). Only capturing a *new*
// snapshot requires login (POST /api/history/capture).
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { data, error } = await supabase
    .from("sync_history_snapshots")
    .select("id, captured_at, listing_count, listings, sources, sync_runs(started_at)")
    .eq("id", params.id)
    .maybeSingle<SnapshotRow>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "No snapshot found with that id." }, { status: 404 });
  }

  return NextResponse.json({
    id: data.id,
    runStartedAt: data.sync_runs?.started_at ?? data.captured_at,
    capturedAt: data.captured_at,
    listingCount: data.listing_count,
    sources: data.sources ?? [],
    listings: data.listings,
  });
}
