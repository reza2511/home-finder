import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { deriveEffectiveStatus } from "@/lib/statusDerive";
import type { StatusResponse, StoredSourceStatus, SyncStatusRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SyncStatusRowDb {
  source_id: string;
  source_name: string;
  last_run_at: string | null;
  last_success_at: string | null;
  status: StoredSourceStatus;
  http_status: number | null;
  listings_found: number;
  added: number;
  updated: number;
  removed: number;
  duration_ms: number | null;
  error_message: string | null;
  extraction_method: string | null;
  deduped_count: number;
  drop_guard_triggered: boolean;
}

// A sync is now started ONLY by scripts/run-sync.ts (the GitHub Actions
// daily 6am run, or a manual `workflow_dispatch` of that same workflow) or
// by a logged-in operator clicking "Run sync now" (POST /api/sync). This
// route used to also carry an ensureInitialSyncHasRun() bootstrap — ran on
// every single GET here (Header.tsx polls this route automatically every
// 60s from any open tab, unattended, and the Status Monitor also calls it
// on every open), and if sync_status ever had fewer rows than the current
// adapter registry (first-ever deploy with an empty table, or a newly
// added adapter with no row yet) it would silently kick off a FULL sync —
// completely unauthenticated, with no login/repo-access gate at all,
// unlike either real trigger above. 2026-08-25: exactly that fired a real,
// unwanted sync ("status-bootstrap" in lib/syncLock.ts's lock — that
// label was this bootstrap's own acquireSyncLock() call) from nothing
// more than a page load/status poll — removed outright rather than
// reworked, since "bootstrap an empty table automatically" is itself the
// behaviour that's no longer wanted: an empty/incomplete sync_status now
// just means the Status Monitor shows fewer/no rows for those sources
// until the next real sync (schedule or manual) runs, same as any other
// day sync_status is simply out of date.
export async function GET() {
  const { data: rows, error } = await supabase
    .from("sync_status")
    .select(
      "source_id, source_name, last_run_at, last_success_at, status, http_status, listings_found, added, updated, removed, duration_ms, error_message, extraction_method, deduped_count, drop_guard_triggered"
    )
    .order("source_name", { ascending: true })
    .returns<SyncStatusRowDb[]>();
  if (error) {
    return NextResponse.json({ error: `Failed to read sync_status from Supabase: ${error.message}` }, { status: 500 });
  }

  const sources: SyncStatusRow[] = (rows ?? []).map((r) => ({
    sourceId: r.source_id,
    sourceName: r.source_name,
    lastRunAt: r.last_run_at,
    lastSuccessAt: r.last_success_at,
    storedStatus: r.status,
    status: deriveEffectiveStatus(r.status, r.last_success_at),
    httpStatus: r.http_status,
    listingsFound: r.listings_found,
    added: r.added,
    updated: r.updated,
    removed: r.removed,
    durationMs: r.duration_ms,
    errorMessage: r.error_message,
    extractionMethod: r.extraction_method,
    dedupedCount: r.deduped_count,
    dropGuardTriggered: r.drop_guard_triggered,
  }));

  const summary = {
    ok: 0,
    no_results: 0,
    blocked: 0,
    error: 0,
    stale: 0,
    not_built: 0,
    total: sources.length,
  };
  for (const s of sources) summary[s.status] += 1;

  const body: StatusResponse = { sources, summary };
  return NextResponse.json(body);
}
