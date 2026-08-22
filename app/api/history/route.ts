import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { listRecentSnapshots } from "@/lib/historyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public — viewing history is for everyone, same as GET /api/listings and
// GET /api/status. Only capturing a new snapshot (POST /api/history/capture)
// requires login. Reads via the anon client, subject to the public SELECT
// RLS policy on sync_history_snapshots/sync_runs (see supabase/migrations/
// 0005_history_public_and_source_breakdown.sql) — the same "real" public
// access listings/sync_status already have, not just an absent app-level
// check.
export async function GET() {
  try {
    const snapshots = await listRecentSnapshots(supabase);
    return NextResponse.json({ snapshots });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
