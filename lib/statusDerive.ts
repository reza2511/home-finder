import type { SourceStatus, StoredSourceStatus } from "./types";

// Syncs run every 12h, so no successful run in over 26h means something is wrong
// even if the last recorded outcome looked fine.
export const STALE_THRESHOLD_MS = 26 * 60 * 60 * 1000;

/**
 * Derives the effective status for display. `blocked`/`error` are already the
 * most actionable signal for the *last* run, so they take priority. `not_built`
 * is a permanent, known state (no scraping logic exists) — it never "goes
 * stale" the way a working-but-quiet source would. Otherwise, if the source
 * hasn't had a successful run recently, it's `stale` regardless of what the
 * last recorded status says (this catches the case where the sync job itself
 * stopped running, not just the adapter failing).
 */
export function deriveEffectiveStatus(
  storedStatus: StoredSourceStatus,
  lastSuccessAt: string | null
): SourceStatus {
  if (storedStatus === "blocked" || storedStatus === "error" || storedStatus === "not_built") {
    return storedStatus;
  }
  const isStale =
    !lastSuccessAt || Date.now() - Date.parse(lastSuccessAt) > STALE_THRESHOLD_MS;
  return isStale ? "stale" : storedStatus;
}
