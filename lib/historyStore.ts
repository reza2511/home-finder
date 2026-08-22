/**
 * Refresh history: records when each full sync starts (`sync_runs`) and
 * captures a full listings snapshot ~2h after that start
 * (`sync_history_snapshots`) — see supabase/migrations/0004_add_sync_history.sql.
 *
 * Why 2h, and why a cron job rather than a live timer: a `setTimeout` held
 * in a serverless function's memory doesn't survive past that invocation
 * ending (Vercel functions aren't long-running processes) — the process
 * launching the sync will be gone long before 2 hours pass. Instead,
 * `recordSyncRunStart()` just writes down *when* a full sync started, and a
 * separate scheduled job (Vercel Cron → GET /api/cron/history-snapshot —
 * see vercel.json) calls `captureDueSnapshots()`, which asks Postgres
 * directly "which runs started ≥2h ago and haven't been snapshotted yet?"
 * and captures each one it finds — regardless of which serverless instance
 * (if any) happens to be running when that moment actually arrives.
 *
 * Cron cadence is once daily (`0 0 * * *`), not every 15 min as originally
 * built — this Vercel project is on the Hobby plan, which rejects any cron
 * expression that would run more than once a day at deploy time ("Hobby
 * accounts are limited to daily cron jobs"), confirmed live: the first
 * deploy with a 15-min schedule failed outright. `captureDueSnapshots()`
 * itself is unaffected — it still correctly captures any run that's been
 * due for anywhere up to a day — but the *actual* capture moment is now
 * "sometime within ~24h of the 2h mark", not a tight ~2h-after-start
 * window. Move this to a per-minute schedule (e.g. every 15 min) if the
 * project is ever upgraded to Pro, which allows per-minute cron scheduling.
 *
 * `captureSnapshotNow()` is the separate manual path — the "Capture history
 * now" button (POST /api/history/capture) — for an instant capture that
 * doesn't wait for the 2h delay or trigger a new sync.
 */
import { requireSupabaseAdmin } from "./db";
import { fetchActiveListings } from "./listingsQuery";

export const SNAPSHOT_DELAY_HOURS = 2;
export const MAX_KEPT_SNAPSHOTS = 3;

export interface HistorySnapshotSummary {
  id: string;
  runStartedAt: string;
  capturedAt: string;
  listingCount: number;
}

/** Inserts a new `sync_runs` row with `started_at = now()`. Called once per
 * *full* sync (see lib/syncEngine.ts's runAllAdapters — never for a
 * targeted `?ids=` retry of a handful of sources, which isn't "a sync" in
 * the sense a user reviewing history would recognise). Best-effort: a
 * failure here is logged, not thrown — history bookkeeping should never
 * block the sync it's trying to describe. */
export async function recordSyncRunStart(): Promise<void> {
  try {
    const admin = requireSupabaseAdmin();
    const { error } = await admin.from("sync_runs").insert({});
    if (error) {
      console.warn(`[historyStore] recordSyncRunStart: insert failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[historyStore] recordSyncRunStart: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface PendingRun {
  id: string;
  started_at: string;
}

/** Finds every `sync_runs` row that started at least SNAPSHOT_DELAY_HOURS
 * ago and has no snapshot yet, captures a full listings snapshot for each,
 * marks it snapshotted, then trims `sync_history_snapshots` down to the
 * most recent MAX_KEPT_SNAPSHOTS overall (deleting the JSONB-heavy rows,
 * not the small `sync_runs` timestamps). Called by the cron route — see
 * app/api/cron/history-snapshot/route.ts. */
export async function captureDueSnapshots(): Promise<{
  processed: number;
  prunedSnapshots: number;
  errors: string[];
}> {
  const admin = requireSupabaseAdmin();
  const errors: string[] = [];

  const cutoff = new Date(Date.now() - SNAPSHOT_DELAY_HOURS * 60 * 60 * 1000).toISOString();
  const { data: pendingRuns, error: pendingErr } = await admin
    .from("sync_runs")
    .select("id, started_at")
    .is("snapshotted_at", null)
    .lte("started_at", cutoff)
    .order("started_at", { ascending: true })
    .returns<PendingRun[]>();

  if (pendingErr) {
    throw new Error(`captureDueSnapshots: failed to read pending sync_runs: ${pendingErr.message}`);
  }

  let processed = 0;
  for (const run of pendingRuns ?? []) {
    try {
      const { listings, error } = await fetchActiveListings(admin);
      if (error) throw new Error(error);

      const { error: insertErr } = await admin.from("sync_history_snapshots").insert({
        run_id: run.id,
        listing_count: listings.length,
        listings,
      });
      if (insertErr) throw new Error(`insert failed: ${insertErr.message}`);

      const { error: markErr } = await admin
        .from("sync_runs")
        .update({ snapshotted_at: new Date().toISOString() })
        .eq("id", run.id);
      if (markErr) throw new Error(`marking snapshotted failed: ${markErr.message}`);

      processed++;
    } catch (err) {
      const message = `run ${run.id} (started ${run.started_at}): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(message);
      console.warn(`[historyStore] captureDueSnapshots: ${message}`);
    }
  }

  const prunedSnapshots = await pruneOldSnapshots();

  return { processed, prunedSnapshots, errors };
}

interface NewRun {
  id: string;
  started_at: string;
}

interface NewSnapshot {
  id: string;
  captured_at: string;
  listing_count: number;
}

/** Manual, instant capture — triggered by the "Capture history now" button
 * (POST /api/history/capture), not the cron job. Creates its own `sync_runs`
 * row (started_at = now()) rather than waiting for or reusing a pending one,
 * so it never interferes with the automatic ~2h-after-start capture — that
 * row is immediately marked snapshotted too, honestly recording that this
 * run's snapshot was taken right away, not after a delay. Same table, same
 * shape, same pruning-to-MAX_KEPT_SNAPSHOTS as the automatic path — just
 * skipping the "wait until due" check entirely. Never triggers a sync;
 * captures whatever is currently in `listings` at the moment it's called. */
export async function captureSnapshotNow(): Promise<HistorySnapshotSummary> {
  const admin = requireSupabaseAdmin();

  const { data: run, error: runErr } = await admin
    .from("sync_runs")
    .insert({})
    .select("id, started_at")
    .single<NewRun>();
  if (runErr || !run) {
    throw new Error(`captureSnapshotNow: failed to create sync_runs row: ${runErr?.message ?? "no row returned"}`);
  }

  const { listings, error } = await fetchActiveListings(admin);
  if (error) throw new Error(error);

  const { data: snapshot, error: insertErr } = await admin
    .from("sync_history_snapshots")
    .insert({ run_id: run.id, listing_count: listings.length, listings })
    .select("id, captured_at, listing_count")
    .single<NewSnapshot>();
  if (insertErr || !snapshot) {
    throw new Error(`captureSnapshotNow: insert failed: ${insertErr?.message ?? "no row returned"}`);
  }

  const { error: markErr } = await admin
    .from("sync_runs")
    .update({ snapshotted_at: snapshot.captured_at })
    .eq("id", run.id);
  if (markErr) {
    // Non-fatal — the snapshot itself is already saved and will still show
    // up in listRecentSnapshots(); this only affects whether the cron job
    // would (redundantly, harmlessly) also try this same run, which it
    // won't anyway since it only looks at runs ≥2h old.
    console.warn(`[historyStore] captureSnapshotNow: marking snapshotted failed (non-fatal): ${markErr.message}`);
  }

  await pruneOldSnapshots();

  return {
    id: snapshot.id,
    runStartedAt: run.started_at,
    capturedAt: snapshot.captured_at,
    listingCount: snapshot.listing_count,
  };
}

/** Keeps only the MAX_KEPT_SNAPSHOTS most recent rows in
 * `sync_history_snapshots` — the JSONB listings blobs are what actually
 * costs space, so this is what "delete older ones to save space" means in
 * practice; the small `sync_runs` timestamp rows are left alone. */
async function pruneOldSnapshots(): Promise<number> {
  const admin = requireSupabaseAdmin();

  const { data: keep, error: keepErr } = await admin
    .from("sync_history_snapshots")
    .select("id")
    .order("captured_at", { ascending: false })
    .limit(MAX_KEPT_SNAPSHOTS)
    .returns<{ id: string }[]>();
  if (keepErr) {
    throw new Error(`pruneOldSnapshots: failed to read current snapshots: ${keepErr.message}`);
  }

  const keepIds = (keep ?? []).map((r) => r.id);
  if (keepIds.length === 0) return 0; // nothing exists yet — nothing to prune

  const { data: deleted, error: deleteErr } = await admin
    .from("sync_history_snapshots")
    .delete()
    .not("id", "in", `(${keepIds.join(",")})`)
    .select("id");
  if (deleteErr) {
    throw new Error(`pruneOldSnapshots: delete failed: ${deleteErr.message}`);
  }

  return deleted?.length ?? 0;
}

/** Up to MAX_KEPT_SNAPSHOTS most recent snapshots, most recent first —
 * summary only (no listings payload), for the sidebar's history buttons.
 * See app/api/history/route.ts. */
export async function listRecentSnapshots(): Promise<HistorySnapshotSummary[]> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("sync_history_snapshots")
    .select("id, captured_at, listing_count, sync_runs(started_at)")
    .order("captured_at", { ascending: false })
    .limit(MAX_KEPT_SNAPSHOTS)
    .returns<{ id: string; captured_at: string; listing_count: number; sync_runs: { started_at: string } | null }[]>();
  if (error) {
    throw new Error(`listRecentSnapshots: read failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    // Falls back to captured_at on the (should-never-happen) chance the
    // parent run row is missing — never throws over a display label.
    runStartedAt: row.sync_runs?.started_at ?? row.captured_at,
    capturedAt: row.captured_at,
    listingCount: row.listing_count,
  }));
}
