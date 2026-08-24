"use client";

import { useEffect, useState } from "react";
import { fetchSession } from "@/lib/authClient";
import {
  captureHistoryNow,
  deleteHistorySnapshot,
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
  /** Called after a snapshot is deleted, only when it was the one currently
   * being viewed — lets the page fall back to live listings instead of
   * going on "viewing a saved snapshot" that no longer exists. */
  onDeleted: (id: string) => void;
}

// Viewing history is public — every visitor sees the list and can recall a
// snapshot, no login needed (GET /api/history, GET /api/history/:id are
// both public routes — see their own files). Only *capturing* a new
// snapshot is login-only: the "Capture history now" button below is
// gated on `authenticated`, and POST /api/history/capture independently
// enforces that server-side regardless of what this component renders.
export default function RefreshHistory({ activeSnapshotId, onSelect, onDeleted }: Props) {
  const [authenticated, setAuthenticated] = useState(false);
  const [snapshots, setSnapshots] = useState<HistorySnapshotSummary[] | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

    // Closes the open info popover on a click OUTSIDE its own row — by
    // checking the actual click target's row (via each row's own
    // data-row-id, walked up with .closest()), not by relying on the
    // ⓘ/🗑 buttons calling e.stopPropagation() to keep this listener from
    // ever seeing their click in the first place. That's what this used to
    // do, and it broke (confirmed live: a click on ⓘ still reached this
    // listener despite stopPropagation() being called on it) — a plain
    // document-level listener here can't assume a descendant's
    // stopPropagation() shielded it. Checking the real target instead
    // means this is correct no matter what: a click inside the currently-
    // open row (ⓘ again, 🗑, or the popover itself) leaves state alone —
    // that row's own button handles opening/closing/deleting itself — a
    // click inside any OTHER row hands off to that row's own ⓘ handler,
    // and a click truly outside every row closes whatever's open. Written
    // as a functional update so it's correct regardless of whether this
    // listener happens to fire before or after the clicked button's own
    // handler for the same click.
    function onDocClick(e: MouseEvent) {
      const rowId = (e.target as Element).closest?.("[data-row-id]")?.getAttribute("data-row-id") ?? null;
      setOpenInfoId((cur) => (cur !== null && rowId !== cur ? null : cur));
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

  // Login-only, same as "Capture history now" — the trash button itself is
  // only rendered when `authenticated` below, and DELETE /api/history/[id]
  // independently rejects an unauthenticated request regardless of that.
  // A quick native confirm() first, since this can't be undone (it removes
  // the snapshot's stored listings payload, not just hides it from the
  // list) — deliberately outside the try/catch so cancelling never shows
  // an error banner or touches `deletingId`.
  async function handleDelete(id: string, label: string) {
    if (!window.confirm(`Delete the ${label} capture? This can't be undone.`)) return;

    setDeletingId(id);
    setError(null);
    try {
      await deleteHistorySnapshot(id);
      await refreshList();
      if (activeSnapshotId === id) onDeleted(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete snapshot");
    } finally {
      setDeletingId(null);
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
            <div key={s.id} className="refresh-history__row" data-row-id={s.id}>
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
                onClick={() => setOpenInfoId((cur) => (cur === s.id ? null : s.id))}
              >
                ⓘ
              </button>
              {authenticated && (
                <button
                  type="button"
                  className="refresh-history__delete"
                  aria-label={`Delete the ${formatDateTime(s.capturedAt)} capture`}
                  disabled={deletingId === s.id}
                  onClick={() => handleDelete(s.id, formatDateTime(s.capturedAt))}
                >
                  {deletingId === s.id ? "…" : "🗑"}
                </button>
              )}
              <div className={`refresh-history__tooltip${openInfoId === s.id ? " refresh-history__tooltip--open" : ""}`}>
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
