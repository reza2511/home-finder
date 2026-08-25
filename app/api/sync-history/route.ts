import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import type { StoredSourceStatus, SyncRunLog, SyncRunSourceLog } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How many past runs to return — enough for the "is this a real trend or a
// bug" comparison (lib/syncRunLog.ts's own doc comment) without the modal
// growing unbounded; the client can always ask for more via ?limit=.
const DEFAULT_RUN_LIMIT = 3;
const MAX_RUN_LIMIT = 20;

interface SyncRunLogRowDb {
  id: string;
  started_at: string;
  finished_at: string | null;
  triggered_by: string;
  total_active_count: number | null;
}

interface SyncRunSourceLogRowDb {
  run_id: string;
  source_id: string;
  source_name: string;
  status: StoredSourceStatus;
  listings_found: number;
  added: number;
  updated: number;
  removed: number;
  deduped_count: number;
  duration_ms: number | null;
  ran_at: string;
}

// Real, stored per-run history (supabase/migrations/0012_sync_run_log.sql)
// — every number here is exactly what lib/syncRunLog.ts recorded at the
// time each source actually ran, never recomputed or estimated. Lets the
// Status Monitor's "Sync history" view show whether a count change between
// runs was a real gain/loss (present across sources, roughly proportional)
// or a bug (one source alone collapsing) by comparing real runs against
// each other, not by guessing.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitParam = Number(searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_RUN_LIMIT)
      : DEFAULT_RUN_LIMIT;

  const { data: runRows, error: runsErr } = await supabase
    .from("sync_runs_log")
    .select("id, started_at, finished_at, triggered_by, total_active_count")
    .order("started_at", { ascending: false })
    .limit(limit)
    .returns<SyncRunLogRowDb[]>();
  if (runsErr) {
    return NextResponse.json({ error: `Failed to read sync_runs_log from Supabase: ${runsErr.message}` }, { status: 500 });
  }

  const runs = runRows ?? [];
  if (runs.length === 0) {
    return NextResponse.json({ runs: [] satisfies SyncRunLog[] });
  }

  const { data: sourceRows, error: sourcesErr } = await supabase
    .from("sync_run_source_log")
    .select("run_id, source_id, source_name, status, listings_found, added, updated, removed, deduped_count, duration_ms, ran_at")
    .in("run_id", runs.map((r) => r.id))
    .order("source_name", { ascending: true })
    .returns<SyncRunSourceLogRowDb[]>();
  if (sourcesErr) {
    return NextResponse.json({ error: `Failed to read sync_run_source_log from Supabase: ${sourcesErr.message}` }, { status: 500 });
  }

  const sourcesByRunId = new Map<string, SyncRunSourceLog[]>();
  for (const r of sourceRows ?? []) {
    const list = sourcesByRunId.get(r.run_id) ?? [];
    list.push({
      sourceId: r.source_id,
      sourceName: r.source_name,
      status: r.status,
      listingsFound: r.listings_found,
      added: r.added,
      updated: r.updated,
      removed: r.removed,
      dedupedCount: r.deduped_count,
      durationMs: r.duration_ms,
      ranAt: r.ran_at,
    });
    sourcesByRunId.set(r.run_id, list);
  }

  const body: { runs: SyncRunLog[] } = {
    runs: runs.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      triggeredBy: r.triggered_by,
      totalActiveCount: r.total_active_count,
      sources: sourcesByRunId.get(r.id) ?? [],
    })),
  };
  return NextResponse.json(body);
}
