/**
 * Refresh history: a full snapshot of the live listings, captured either
 * once daily by Vercel Cron (GET /api/cron/history-snapshot, 06:00 —
 * see vercel.json) or on demand by a logged-in operator ("Capture history
 * now", POST /api/history/capture) — see supabase/migrations/0004_add_
 * sync_history.sql and 0005_history_public_and_source_breakdown.sql.
 *
 * Both paths call the same `captureSnapshotNow()` — there's no "wait until
 * some condition is due" logic at all (an earlier version tried to capture
 * a fixed 2h after a sync started, using a separate `sync_runs` row to
 * survive serverless functions not staying alive that long; that whole
 * mechanism is gone). `sync_runs` still exists and still gets one new row
 * per capture (immediately marked snapshotted) — kept only as each
 * snapshot's own timestamp record via the FK, not for any scheduling logic.
 *
 * Viewing history (list + recall a snapshot) is public — see
 * app/api/history/route.ts and app/api/history/[id]/route.ts, and the
 * public "publicly readable" RLS policies in 0005's migration. Only
 * capturing a new one requires login (app/api/history/capture/route.ts).
 *
 * Each snapshot also stores a small per-source breakdown (`sources`,
 * computed once here from that capture's own listings — not recomputed
 * per read) so the info tooltip on each history entry can show "N sources
 * updated: A, B, C" and each source's listing count without ever fetching
 * that snapshot's full listings payload just to render a list item.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAdmin } from "./db";
import { fetchActiveListings } from "./listingsQuery";
import { summarizeBySource, type SourceBreakdownEntry } from "./sourceBreakdown";

export const MAX_KEPT_SNAPSHOTS = 10;

export type { SourceBreakdownEntry };

export interface HistorySnapshotSummary {
  id: string;
  runStartedAt: string;
  capturedAt: string;
  listingCount: number;
  sources: SourceBreakdownEntry[];
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

/** Captures whatever is currently in `listings` right now, as a new history
 * entry — used by both the daily cron and the manual "Capture history now"
 * button; neither waits for anything or depends on a sync having just run.
 * Always creates its own fresh `sync_runs` row (see file header for why
 * that table still exists). Prunes down to MAX_KEPT_SNAPSHOTS afterwards. */
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

  const sources = summarizeBySource(listings);

  const { data: snapshot, error: insertErr } = await admin
    .from("sync_history_snapshots")
    .insert({ run_id: run.id, listing_count: listings.length, listings, sources })
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
    // up in listRecentSnapshots(); snapshotted_at isn't read by anything
    // else any more (see file header), so a failure here has no other
    // effect.
    console.warn(`[historyStore] captureSnapshotNow: marking snapshotted failed (non-fatal): ${markErr.message}`);
  }

  await pruneOldSnapshots();

  return {
    id: snapshot.id,
    runStartedAt: run.started_at,
    capturedAt: snapshot.captured_at,
    listingCount: snapshot.listing_count,
    sources,
  };
}

/**
 * Deletes one snapshot by id — used by the "delete" (trash) button next to
 * each history entry (DELETE /api/history/[id], login-only — see that
 * route's own comment). Only removes the `sync_history_snapshots` row
 * itself (the actual listings payload); its parent `sync_runs` row is left
 * alone, same as pruneOldSnapshots() above leaves it — that table is kept
 * only as each snapshot's timestamp record via the FK, not for anything
 * that would need cleaning up in step with it (see this file's header).
 * Returns whether a row actually existed to delete, so the route can
 * return a real 404 instead of a false "ok" for an id that's already gone
 * (e.g. a double click, or one that pruneOldSnapshots() already dropped).
 */
export async function deleteSnapshot(id: string): Promise<boolean> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("sync_history_snapshots")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) {
    throw new Error(`deleteSnapshot(${id}): delete failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

/** Keeps only the MAX_KEPT_SNAPSHOTS most recent rows in
 * `sync_history_snapshots` — the JSONB listings blobs are what actually
 * costs space, so this is what "drop the oldest" means in practice; the
 * small `sync_runs` timestamp rows are left alone. */
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

interface SnapshotSummaryRow {
  id: string;
  captured_at: string;
  listing_count: number;
  sources: SourceBreakdownEntry[] | null;
  sync_runs: { started_at: string } | null;
}

/** Up to MAX_KEPT_SNAPSHOTS most recent snapshots, most recent first —
 * summary only (no listings payload), for the history list. Public data —
 * pass the anon client from a public route (app/api/history/route.ts) or
 * the admin client from a privileged/internal caller; RLS allows public
 * SELECT on both tables involved either way (see 0005's migration). */
export async function listRecentSnapshots(client: SupabaseClient): Promise<HistorySnapshotSummary[]> {
  const { data, error } = await client
    .from("sync_history_snapshots")
    .select("id, captured_at, listing_count, sources, sync_runs(started_at)")
    .order("captured_at", { ascending: false })
    .limit(MAX_KEPT_SNAPSHOTS)
    .returns<SnapshotSummaryRow[]>();
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
    sources: row.sources ?? [], // empty for the handful of snapshots captured before this field existed
  }));
}
