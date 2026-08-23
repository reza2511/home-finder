/**
 * Daily statistics snapshots for the public Statistics page
 * (supabase/migrations/0009_stats_daily_snapshots.sql) — a small, never-
 * pruned history of "total listings + per-source counts, per day", distinct
 * from lib/historyStore.ts's refresh history (which stores full listings
 * payloads and is capped at 10 rows — see that file's own header).
 *
 * captureDailyStatsSnapshot() is called once at the end of every
 * runAllAdapters() run (lib/syncEngine.ts), so it fires wherever a sync
 * actually runs — in practice, once a day via the GitHub Actions daily
 * sync (.github/workflows/daily-sync.yml), plus the rare manual "Run sync
 * now" / first-ever-load bootstrap. Upserts on `date` (UTC calendar date),
 * so more than one capture on the same day just overwrites that day's row
 * with the latest counts rather than creating a duplicate — "one row per
 * day" stays true regardless of how many times a sync happens to run on
 * it.
 */
import { requireSupabaseAdmin } from "./db";
import { fetchActiveListings } from "./listingsQuery";
import { summarizeBySource, type SourceBreakdownEntry } from "./sourceBreakdown";

export interface DailyStatsSnapshot {
  date: string; // "YYYY-MM-DD", UTC
  totalCount: number;
  sources: SourceBreakdownEntry[];
  capturedAt: string;
}

/** UTC calendar date, e.g. "2026-08-23" — the daily sync runs at 6am UK
 * time, which is always within an hour of UTC, so it never lands on a
 * different UTC date than the UK date it was meant for. */
function todayDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function captureDailyStatsSnapshot(): Promise<DailyStatsSnapshot> {
  const admin = requireSupabaseAdmin();

  const { listings, error } = await fetchActiveListings(admin);
  if (error) {
    throw new Error(`captureDailyStatsSnapshot: failed to read active listings: ${error}`);
  }

  const sources = summarizeBySource(listings);
  const date = todayDateKey();

  const { data, error: upsertErr } = await admin
    .from("stats_daily_snapshots")
    .upsert(
      { date, total_count: listings.length, sources, captured_at: new Date().toISOString() },
      { onConflict: "date" }
    )
    .select("date, total_count, sources, captured_at")
    .single<{ date: string; total_count: number; sources: SourceBreakdownEntry[]; captured_at: string }>();
  if (upsertErr || !data) {
    throw new Error(`captureDailyStatsSnapshot: upsert failed: ${upsertErr?.message ?? "no row returned"}`);
  }

  return {
    date: data.date,
    totalCount: data.total_count,
    sources: data.sources,
    capturedAt: data.captured_at,
  };
}
