"use client";

import { useEffect, useState } from "react";
import { fetchSession } from "@/lib/authClient";
import { fetchHistoryList, fetchHistorySnapshot, type HistorySnapshotDetail, type HistorySnapshotSummary } from "@/lib/historyClient";
import { formatDateTime } from "@/lib/relativeTime";

interface Props {
  /** Id of the snapshot currently being viewed, or null when showing live
   * listings — just for highlighting the matching button. */
  activeSnapshotId: string | null;
  onSelect: (snapshot: HistorySnapshotDetail) => void;
}

// Visible only to a logged-in user — checked the same way every other
// protected control in this app checks it (Header, StatusMonitorModal): a
// real session fetched from GET /api/auth/session, itself backed by the
// same server-side cookie check as every history API route. A public
// visitor never sees this section at all, not even a disabled/hint version
// — it renders nothing until authenticated is confirmed true.
export default function RefreshHistory({ activeSnapshotId, onSelect }: Props) {
  const [authenticated, setAuthenticated] = useState(false);
  const [snapshots, setSnapshots] = useState<HistorySnapshotSummary[] | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (cancelled) return;
        setAuthenticated(s.authenticated);
        if (s.authenticated) {
          fetchHistoryList()
            .then((list) => !cancelled && setSnapshots(list))
            .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load history"));
        }
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authenticated) return null;

  async function handleClick(id: string) {
    setLoadingId(id);
    setError(null);
    try {
      const snapshot = await fetchHistorySnapshot(id);
      onSelect(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load snapshot");
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <section className="refresh-history" aria-label="Refresh history">
      <h2 className="dev-filter__heading">Refresh history</h2>

      {error && <div className="status-banner status-banner--error">{error}</div>}

      {snapshots === null ? (
        <p className="dev-filter__empty">Loading…</p>
      ) : snapshots.length === 0 ? (
        <p className="dev-filter__empty">No completed snapshots yet — the first sync's snapshot is captured 2h after it starts.</p>
      ) : (
        <div className="refresh-history__list">
          {snapshots.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`refresh-history__item${activeSnapshotId === s.id ? " refresh-history__item--active" : ""}`}
              onClick={() => handleClick(s.id)}
              disabled={loadingId === s.id}
              aria-pressed={activeSnapshotId === s.id}
            >
              {loadingId === s.id ? "Loading…" : formatDateTime(s.runStartedAt)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
