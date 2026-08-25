import type { SyncRunLog } from "./types";

export type { SyncRunLog, SyncRunSourceLog } from "./types";

/** Real, stored per-run sync history (GET /api/sync-history) — most recent
 * run first. Public, same as GET /api/status. */
export async function fetchSyncHistory(limit = 3): Promise<SyncRunLog[]> {
  const res = await fetch(`/api/sync-history?limit=${limit}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load sync history (${res.status})`);
  }
  const data = await res.json();
  return data.runs;
}
