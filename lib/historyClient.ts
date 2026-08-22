import type { Listing } from "./types";

export interface HistorySnapshotSummary {
  id: string;
  runStartedAt: string;
  capturedAt: string;
  listingCount: number;
}

export interface HistorySnapshotDetail extends HistorySnapshotSummary {
  listings: Listing[];
}

export async function fetchHistoryList(): Promise<HistorySnapshotSummary[]> {
  const res = await fetch("/api/history", { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load refresh history (${res.status})`);
  }
  const data = await res.json();
  return data.snapshots;
}

export async function fetchHistorySnapshot(id: string): Promise<HistorySnapshotDetail> {
  const res = await fetch(`/api/history/${id}`, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load snapshot (${res.status})`);
  }
  return res.json();
}
