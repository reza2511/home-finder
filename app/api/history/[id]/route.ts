import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { requireSupabaseAdmin } from "@/lib/db";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SnapshotRow {
  id: string;
  captured_at: string;
  listing_count: number;
  listings: Listing[];
  sync_runs: { started_at: string } | null;
}

// Same real, server-side session check as POST /api/sync — a public
// visitor gets 401 regardless of what the front-end shows or hides, and
// can't recall a past snapshot's data even by guessing/enumerating an id.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in to view refresh history." }, { status: 401 });
  }

  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("sync_history_snapshots")
    .select("id, captured_at, listing_count, listings, sync_runs(started_at)")
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
    listings: data.listings,
  });
}
