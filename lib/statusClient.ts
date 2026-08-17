import type { StatusResponse } from "./types";

export type { StatusResponse, SyncStatusRow, StatusSummary, SourceStatus } from "./types";

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load source status (${res.status})`);
  }
  return res.json();
}

export async function triggerSync(): Promise<void> {
  const res = await fetch("/api/sync", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to trigger sync (${res.status})`);
  }
}
