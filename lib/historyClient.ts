import type { Listing } from "./types";

export interface SourceBreakdownEntry {
  sourceId: string;
  sourceName: string;
  listingCount: number;
}

export interface HistorySnapshotSummary {
  id: string;
  runStartedAt: string;
  capturedAt: string;
  listingCount: number;
  sources: SourceBreakdownEntry[];
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

/** Manual, instant capture — the "Capture history now" button. Doesn't
 * trigger a sync; saves whatever's currently in `listings` right now, in
 * the same format the daily automatic capture uses. Requires login — the
 * server rejects an unauthenticated request regardless of this call site. */
export async function captureHistoryNow(): Promise<HistorySnapshotSummary> {
  const res = await fetch("/api/history/capture", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to capture history (${res.status})`);
  }
  const data = await res.json();
  return data.snapshot;
}
