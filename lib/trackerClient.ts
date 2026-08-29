import type { TrackerBackupSummary, TrackerPrefs, TrackerRow, TrackerRowPatch } from "./trackerTypes";

export async function fetchTracker(): Promise<TrackerRow[]> {
  const res = await fetch("/api/tracker", { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load tracker (${res.status})`);
  }
  const data = await res.json();
  return data.rows;
}

export async function addTrackerRow(url: string): Promise<TrackerRow> {
  const res = await fetch("/api/tracker", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to add property (${res.status})`);
  }
  const data = await res.json();
  return data.row;
}

export async function updateTrackerRow(id: string, patch: TrackerRowPatch): Promise<TrackerRow> {
  const res = await fetch(`/api/tracker/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to save change (${res.status})`);
  }
  const data = await res.json();
  return data.row;
}

export async function deleteTrackerRow(id: string): Promise<void> {
  const res = await fetch(`/api/tracker/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to remove row (${res.status})`);
  }
}

export async function fetchTrackerBackups(): Promise<TrackerBackupSummary[]> {
  const res = await fetch("/api/tracker/backups", { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load backups (${res.status})`);
  }
  const data = await res.json();
  return data.backups;
}

export async function restoreTrackerBackup(date: string): Promise<TrackerRow[]> {
  const res = await fetch("/api/tracker/backups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to restore backup (${res.status})`);
  }
  const data = await res.json();
  return data.rows;
}

export async function fetchTrackerPrefs(): Promise<TrackerPrefs> {
  const res = await fetch("/api/tracker/prefs", { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load preferences (${res.status})`);
  }
  const data = await res.json();
  return data.prefs;
}

export async function updateTrackerPrefs(patch: Partial<TrackerPrefs>): Promise<TrackerPrefs> {
  const res = await fetch("/api/tracker/prefs", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to save preference (${res.status})`);
  }
  const data = await res.json();
  return data.prefs;
}
