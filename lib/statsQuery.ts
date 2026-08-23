import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceBreakdownEntry } from "./sourceBreakdown";
import type { DailyStatsSnapshot } from "./statsStore";

interface StatsRow {
  date: string;
  total_count: number;
  sources: SourceBreakdownEntry[] | null;
  captured_at: string;
}

/** Every daily stats snapshot, oldest first (chart order) — see
 * supabase/migrations/0009_stats_daily_snapshots.sql. Never pruned, but
 * realistically one row per day, so no pagination is needed the way
 * lib/listingsQuery.ts's fetchAllActiveListingRows needs it. */
export async function fetchDailyStats(
  client: SupabaseClient
): Promise<{ daily: DailyStatsSnapshot[]; error: string | null }> {
  const { data, error } = await client
    .from("stats_daily_snapshots")
    .select("date, total_count, sources, captured_at")
    .order("date", { ascending: true })
    .returns<StatsRow[]>();
  if (error) {
    return { daily: [], error: `Failed to read stats_daily_snapshots from Supabase: ${error.message}` };
  }
  return {
    daily: (data ?? []).map((r) => ({
      date: r.date,
      totalCount: r.total_count,
      sources: r.sources ?? [],
      capturedAt: r.captured_at,
    })),
    error: null,
  };
}
