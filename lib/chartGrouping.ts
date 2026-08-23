import type { SourceBreakdownEntry } from "./sourceBreakdown";
import type { DailyStatsSnapshot } from "./statsStore";
import { OTHER_LABEL, OTHER_SOURCE_ID, TOP_N_CHART_SOURCES } from "./chartPalette";

export interface GroupedSourceCount {
  sourceId: string;
  sourceName: string;
  listingCount: number;
}

/**
 * Top N sources by count, with everything past that folded into a single
 * "Other" entry — the dataviz series-count ladder's rule for a categorical
 * chart past its token ceiling: never generate more hues, fold the tail.
 * Only ever produces an "Other" entry when there are genuinely more than
 * `topN` sources; with fewer, every real source is kept as itself.
 *
 * `entries` must already be sorted by count, descending (GET /api/stats
 * sorts `bySource` this way) — "top" means "top by today's live count".
 */
export function groupTopSourcesWithOther(
  entries: SourceBreakdownEntry[],
  topN: number = TOP_N_CHART_SOURCES
): { topSourceIds: string[]; grouped: GroupedSourceCount[] } {
  if (entries.length <= topN) {
    const grouped = entries.map((e) => ({ sourceId: e.sourceId, sourceName: e.sourceName, listingCount: e.listingCount }));
    return { topSourceIds: grouped.map((e) => e.sourceId), grouped };
  }

  const top = entries.slice(0, topN);
  const rest = entries.slice(topN);
  const otherCount = rest.reduce((sum, e) => sum + e.listingCount, 0);

  const grouped: GroupedSourceCount[] = top.map((e) => ({
    sourceId: e.sourceId,
    sourceName: e.sourceName,
    listingCount: e.listingCount,
  }));
  if (otherCount > 0) {
    grouped.push({ sourceId: OTHER_SOURCE_ID, sourceName: OTHER_LABEL, listingCount: otherCount });
  }

  return { topSourceIds: top.map((e) => e.sourceId), grouped };
}

export interface DailyChartRow {
  date: string; // "YYYY-MM-DD"
  label: string; // "23 Aug"
  total: number;
  /** Per-source count for that day, keyed by sourceId (topSourceIds only)
   * plus OTHER_SOURCE_ID for everything folded — see buildDailyChartRows. */
  bySourceId: Record<string, number>;
}

/**
 * Reshapes `daily` (one row per day, each carrying that day's own full
 * per-source breakdown) into one flat row per day keyed by `topSourceIds`
 * — the fixed set decided ONCE from today's live counts (StatsSourcePie
 * uses the same set), so a source's stacked-bar color never changes day to
 * day even though which sources were biggest may have differed on an
 * earlier day. A source absent from a given day's real breakdown
 * genuinely had 0 active listings that day (or didn't exist as a source
 * yet) — either way 0 is the accurate value, not a fabrication.
 */
export function buildDailyChartRows(daily: DailyStatsSnapshot[], topSourceIds: string[]): DailyChartRow[] {
  const topSet = new Set(topSourceIds);

  return daily.map((day) => {
    const bySourceId: Record<string, number> = {};
    for (const id of topSourceIds) bySourceId[id] = 0;
    bySourceId[OTHER_SOURCE_ID] = 0;

    for (const s of day.sources) {
      if (topSet.has(s.sourceId)) {
        bySourceId[s.sourceId] = s.listingCount;
      } else {
        bySourceId[OTHER_SOURCE_ID] += s.listingCount;
      }
    }

    const [year, month, dayOfMonth] = day.date.split("-").map(Number);
    const label = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(
      new Date(Date.UTC(year, month - 1, dayOfMonth))
    );

    return { date: day.date, label, total: day.totalCount, bySourceId };
  });
}
