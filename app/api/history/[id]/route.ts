import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { isAuthenticated } from "@/lib/auth";
import { deleteSnapshot, type SourceBreakdownEntry } from "@/lib/historyStore";
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

// Login-only — same real, server-side session check as POST
// /api/history/capture, not just an absent button in the UI: an
// unauthenticated request is rejected here regardless of what the client
// sends. Deleting a snapshot is also blocked at the database layer even
// for a caller that somehow got past this check — sync_history_snapshots
// has no anon/authenticated delete RLS policy at all (see supabase/
// migrations/0005_history_public_and_source_breakdown.sql), so only the
// service_role key (used by lib/historyStore.ts's deleteSnapshot(), via
// requireSupabaseAdmin()) can ever remove a row here.
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in to delete a snapshot." }, { status: 401 });
  }

  try {
    const deleted = await deleteSnapshot(params.id);
    if (!deleted) {
      return NextResponse.json({ error: "No snapshot found with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
