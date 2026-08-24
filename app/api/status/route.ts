import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { adapters } from "@/lib/adapters";
import { runAllAdapters } from "@/lib/syncEngine";
import { acquireSyncLock, releaseSyncLock } from "@/lib/syncLock";
import { deriveEffectiveStatus } from "@/lib/statusDerive";
import type { StatusResponse, StoredSourceStatus, SyncStatusRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// This route's first-ever hit can trigger a full browser-based sync (see
// ensureInitialSyncHasRun below) — same reasoning/caveats as
// app/api/sync/route.ts's maxDuration.
export const maxDuration = 300;

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
}

/**
 * Runs on first-ever load, and again whenever a new adapter has been added
 * to the registry but has no row yet (e.g. after this deploy) — this is
 * the ONLY thing that ever makes a plain, unauthenticated GET request
 * capable of kicking off a full sync (every other trigger — the Vercel
 * "Run sync now" button, the GitHub Actions daily run — requires either a
 * login session or repo access). That's tolerable for "bootstrap an empty
 * table once," but this route is also polled automatically, by every open
 * tab, completely unattended (Header.tsx's 60s interval calls GET
 * /api/status, not just a user opening the Status Monitor) — so it must
 * go through the same lib/syncLock.ts lock as every other sync trigger
 * (2026-08-24: it didn't, which meant this path alone could still collide
 * with a real sync in progress even after every other entry point was
 * locked down). Unlike the other two callers, a lock already held here is
 * NOT reported as an error — this is a passive background check, not
 * something a person asked for, so it just skips this time (the condition
 * will simply be re-checked on the next poll) rather than failing an
 * otherwise-fine status read over it.
 */
async function ensureInitialSyncHasRun(): Promise<void> {
  const ids = adapters.map((a) => a.id);
  const { count, error } = await supabase
    .from("sync_status")
    .select("source_id", { count: "exact", head: true })
    .in("source_id", ids);
  if (error) {
    throw new Error(`ensureInitialSyncHasRun: failed to read sync_status from Supabase: ${error.message}`);
  }
  if ((count ?? 0) >= ids.length) return;

  const lock = await acquireSyncLock("status-bootstrap");
  if (!lock.acquired) return; // a real sync is already running elsewhere — leave it alone
  try {
    await runAllAdapters();
  } finally {
    await releaseSyncLock(lock.token);
  }
}

export async function GET() {
  await ensureInitialSyncHasRun();

  const { data: rows, error } = await supabase
    .from("sync_status")
    .select(
      "source_id, source_name, last_run_at, last_success_at, status, http_status, listings_found, added, updated, removed, duration_ms, error_message, extraction_method, deduped_count"
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
