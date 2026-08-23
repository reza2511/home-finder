export interface RemovedTimeRange {
  id: string;
  label: string;
  /** Short "since X" phrase for the count sentence ("N listings removed in
   * the last {shortLabel}") — separate from `label` (the filter pill's own
   * text) so that sentence never doubles up a range name, e.g. "in the
   * last weekly (7 days)". */
  shortLabel: string;
  /** Window size in days, measured back from now. "1 month"/"2 months"/
   * "3 months" use 30/60/90 as a fixed day-count bucket, same as every
   * other range here, rather than calendar months (which vary in length)
   * — simplest to reason about and consistent across every option. */
  days: number;
}

export const REMOVED_TIME_RANGES: RemovedTimeRange[] = [
  { id: "daily", label: "Daily (last 24h)", shortLabel: "24 hours", days: 1 },
  { id: "weekly", label: "Weekly (7 days)", shortLabel: "7 days", days: 7 },
  { id: "2weeks", label: "2 weeks", shortLabel: "2 weeks", days: 14 },
  { id: "3weeks", label: "3 weeks", shortLabel: "3 weeks", days: 21 },
  { id: "1month", label: "1 month", shortLabel: "1 month", days: 30 },
  { id: "2months", label: "2 months", shortLabel: "2 months", days: 60 },
  { id: "3months", label: "3 months", shortLabel: "3 months", days: 90 },
];

export const DEFAULT_REMOVED_TIME_RANGE_ID = "weekly";

/** The widest range the UI ever offers (3 months) — GET /api/removed uses
 * this to bound how far back it queries Supabase, so the payload doesn't
 * keep growing forever as more listings get removed over the app's
 * lifetime; every range the filter pills offer is a subset of it, applied
 * client-side against this one fetch (same pattern AppShell uses for the
 * live listings grid — fetch once, filter in memory). */
export const MAX_REMOVED_TIME_RANGE_DAYS = Math.max(...REMOVED_TIME_RANGES.map((r) => r.days));

export function removedTimeRangeCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
