import type { SyncEvent } from "./types";

export async function fetchSyncEvents(limit = 20): Promise<SyncEvent[]> {
  const res = await fetch(`/api/sync-events?limit=${limit}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load auto-action log (${res.status})`);
  }
  const body: { events: SyncEvent[] } = await res.json();
  return body.events;
}
