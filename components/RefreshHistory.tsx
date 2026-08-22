"use client";

import { useEffect, useState } from "react";
import { fetchSession } from "@/lib/authClient";
import {
  captureHistoryNow,
  fetchHistoryList,
  fetchHistorySnapshot,
  type HistorySnapshotDetail,
  type HistorySnapshotSummary,
} from "@/lib/historyClient";
import { formatDateTime } from "@/lib/relativeTime";

interface Props {
  /** Id of the snapshot currently being viewed, or null when showing live
   * listings — just for highlighting the matching button. */
  activeSnapshotId: string | null;
  onSelect: (snapshot: HistorySnapshotDetail) => void;
}

// Viewing history is public — every visitor sees the list and can recall a
// snapshot, no login needed (GET /api/history, GET /api/history/:id are
// both public routes — see their own files). Only *capturing* a new
// snapshot is login-only: the "Capture history now" button below is
// gated on `authenticated`, and POST /api/history/capture independently
// enforces that server-side regardless of what this component renders.
export default function RefreshHistory({ activeSnapshotId, onSelect }: Props) {
  const [authenticated, setAuthenticated] = useState(false);
  const [snapshots, setSnapshots] = useState<HistorySnapshotSummary[] | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [openInfoId, setOpenInfoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refreshList() {
    return fetchHistoryList().then(setSnapshots);
  }

  useEffect(() => {
    let cancelled = false;

    fetchHistoryList()
      .then((list) => !cancelled && setSnapshots(list))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load history"));

    fetchSession()
      .then((s) => !cancelled && setAuthenticated(s.authenticated))
      .catch(() => !cancelled && setAuthenticated(false));

    function onDocClick() {
      setOpenInfoId(null);
    }
    document.addEventListener("click", onDocClick);

    return () => {
      cancelled = true;
      document.removeEventListener("click", onDocClick);
    };
  }, []);

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

  // Instant capture — does NOT trigger a sync and does NOT wait for the
  // daily 06:00 cron; saves whatever's currently in `listings` right now
  // (see POST /api/history/capture). Re-fetches the list afterwards so the
  // new snapshot (and the "oldest dropped past 10" effect) shows up
  // immediately.
  async function handleCaptureNow() {
    setCapturing(true);
    setError(null);
    try {
      await captureHistoryNow();
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to capture history");
    } finally {
      setCapturing(false);
    }
  }

  return (
    <section className="refresh-history" aria-label="Refresh history">
      <div className="refresh-history__header">
        <h2 className="dev-filter__heading">Refresh history</h2>
        {authenticated && (
          <button
            type="button"
            className="btn btn--ghost refresh-history__capture-btn"
            onClick={handleCaptureNow}
            disabled={capturing}
          >
            {capturing ? "Capturing…" : "Capture history now"}
          </button>
        )}
      </div>

      {error && <div className="status-banner status-banner--error">{error}</div>}

      {snapshots === null ? (
        <p className="dev-filter__empty">Loading…</p>
      ) : snapshots.length === 0 ? (
        <p className="dev-filter__empty">No snapshots yet — one is captured automatically every day at 06:00.</p>
      ) : (
        <div className="refresh-history__list">
          {snapshots.map((s) => (
            <div key={s.id} className="refresh-history__row">
              <button
                type="button"
                className={`refresh-history__item${activeSnapshotId === s.id ? " refresh-history__item--active" : ""}`}
                onClick={() => handleClick(s.id)}
                disabled={loadingId === s.id}
                aria-pressed={activeSnapshotId === s.id}
              >
                {loadingId === s.id ? "Loading…" : formatDateTime(s.runStartedAt)}
              </button>
              <button
                type="button"
                className="refresh-history__info"
                aria-label={`Details for the ${formatDateTime(s.capturedAt)} capture`}
                aria-expanded={openInfoId === s.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenInfoId((cur) => (cur === s.id ? null : s.id));
                }}
              >
                ⓘ
              </button>
              <div
                className={`refresh-history__tooltip${openInfoId === s.id ? " refresh-history__tooltip--open" : ""}`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="refresh-history__tooltip-row">
                  <strong>Captured:</strong> {formatDateTime(s.capturedAt)}
                </div>
                <div className="refresh-history__tooltip-row">
                  <strong>Total houses:</strong> {s.listingCount}
                </div>
                <div className="refresh-history__tooltip-row">
                  <strong>
                    {s.sources.length} source{s.sources.length === 1 ? "" : "s"} updated:
                  </strong>
                </div>
                {s.sources.length > 0 && (
                  <ul className="refresh-history__tooltip-sources">
                    {s.sources.map((src) => (
                      <li key={src.sourceId}>
                        {src.sourceName} <span className="refresh-history__tooltip-count">{src.listingCount}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
