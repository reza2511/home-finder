import { requireSupabaseAdmin } from "./db";
import type { StoredSourceStatus } from "./types";

/**
 * Per-run sync history (supabase/migrations/0012_sync_run_log.sql) — unlike
 * sync_status, which only ever holds each source's LATEST numbers, these
 * two tables keep every past run's per-source added/updated/removed/found
 * counts plus the total active-listing count once the whole run finished.
 * Exists so a real count change (1200 -> 1360 -> 1450) can be told apart
 * from a bug making one source collapse to near-zero, by actually comparing
 * runs against each other (GET /api/sync-history) rather than only ever
 * seeing the most recent snapshot.
 *
 * Every function here is best-effort: a logging failure must never fail the
 * sync itself (same convention as recordRemovedFavourites in
 * lib/listingsStore.ts and captureDailyStatsSnapshot in lib/statsStore.ts)
 * — a missing history row is a worse debugging experience, not a reason to
 * lose real listings data over.
 */

export interface SourceRunLogInput {
  sourceId: string;
  sourceName: string;
  status: StoredSourceStatus;
  listingsFound: number;
  added: number;
  updated: number;
  removed: number;
  dedupedCount: number;
  durationMs: number;
}

/** Creates the one header row for a whole sync run and returns its id.
 * `triggeredBy` is "github-actions" or "vercel-manual" — same labels
 * lib/syncLock.ts already uses, so the two logs read consistently. Callers
 * pass the returned id into every runAllAdapters()/runOne() call that's
 * part of this same run, then call finishSyncRunLog() once at the very end.
 *
 * Not best-effort like the rest of this file: without a run id there is
 * nowhere for recordSourceRunLog() to attach its rows, so a failure here
 * throws — same treatment acquireSyncLock() already gets for the same
 * reason (lib/syncLock.ts). */
export async function startSyncRunLog(triggeredBy: string): Promise<string> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("sync_runs_log")
    .insert({ triggered_by: triggeredBy })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) {
    throw new Error(`startSyncRunLog: failed to create run row: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

/** Records one source's result for a run. Called right alongside that
 * source's own sync_status upsert (lib/syncEngine.ts's runOne) so the two
 * always agree on a source's most recent numbers. */
export async function recordSourceRunLog(runId: string, input: SourceRunLogInput): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { error } = await admin.from("sync_run_source_log").insert({
    run_id: runId,
    source_id: input.sourceId,
    source_name: input.sourceName,
    status: input.status,
    listings_found: input.listingsFound,
    added: input.added,
    updated: input.updated,
    removed: input.removed,
    deduped_count: input.dedupedCount,
    duration_ms: input.durationMs,
  });
  if (error) {
    console.warn(`[syncRunLog] recordSourceRunLog(${input.sourceId}): insert failed (non-fatal): ${error.message}`);
  }
}

/** Stamps a run as finished and records the real total active-listing count
 * at that moment — called once, after every source in the run has finished
 * (scripts/run-sync.ts's loop, or the single runAllAdapters() call in
 * app/api/sync/route.ts), never per-source. A run that crashed before this
 * ever runs simply keeps `finished_at`/`total_active_count` both null —
 * visible in the history as an incomplete run, not silently hidden. */
export async function finishSyncRunLog(runId: string): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { count, error: countErr } = await admin
    .from("listings")
    .select("*", { count: "exact", head: true })
    .eq("active", true);
  if (countErr) {
    console.warn(`[syncRunLog] finishSyncRunLog(${runId}): failed to count active listings (non-fatal): ${countErr.message}`);
  }
  const { error } = await admin
    .from("sync_runs_log")
    .update({ finished_at: new Date().toISOString(), total_active_count: count ?? null })
    .eq("id", runId);
  if (error) {
    console.warn(`[syncRunLog] finishSyncRunLog(${runId}): update failed (non-fatal): ${error.message}`);
  }
}
