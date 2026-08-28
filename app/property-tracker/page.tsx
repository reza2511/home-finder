"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import PropertyTrackerTable from "@/components/PropertyTrackerTable";
import { fetchSession } from "@/lib/authClient";
import {
  addTrackerRow,
  deleteTrackerRow,
  fetchTracker,
  fetchTrackerBackups,
  restoreTrackerBackup,
  updateTrackerRow,
} from "@/lib/trackerClient";
import { exportTrackerToExcel } from "@/lib/trackerExport";
import { sortTrackerRows } from "@/lib/trackerSort";
import { formatDateTime } from "@/lib/relativeTime";
import type { TrackerBackupSummary, TrackerRow, TrackerRowPatch } from "@/lib/trackerTypes";

// Fields that toggle instantly (tick boxes) save right away; free-text/date
// fields debounce so fast typing doesn't fire a PATCH per keystroke — see
// scheduleSave below. "Auto-save on every edit" just means no explicit Save
// button, not literally one request per character.
const DEBOUNCE_MS = 700;
const IMMEDIATE_FIELDS = new Set<keyof TrackerRowPatch>(["rejected", "viewed", "contactedAgent"]);

// Requires login (Stage A auth), same real, server-side session cookie
// check as /compare and /favourites — a public visitor is redirected to
// /login rather than shown a form that would just 401 on every request.
// Every /api/tracker route independently re-checks isAuthenticated() itself
// (and property_tracker/property_tracker_backups have no public RLS policy
// at all — see supabase/migrations/0014_property_tracker.sql), so this
// redirect is a UX nicety on top of real server-side enforcement, not the
// enforcement itself.
export default function PropertyTrackerPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  const [rows, setRows] = useState<TrackerRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const pendingPatchRef = useRef<Map<string, TrackerRowPatch>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const [showBackups, setShowBackups] = useState(false);
  const [backups, setBackups] = useState<TrackerBackupSummary[] | null>(null);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [restoringDate, setRestoringDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (cancelled) return;
        setAuthenticated(s.authenticated);
        setAuthChecked(true);
        if (!s.authenticated) {
          router.replace("/login");
          return;
        }
        return fetchTracker().then((r) => {
          if (!cancelled) setRows(r);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setAuthChecked(true);
        setLoadError(err instanceof Error ? err.message : "Failed to load tracker");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Flush any still-pending debounced saves on unmount, so navigating away
  // right after typing never silently drops the last edit.
  useEffect(() => {
    return () => {
      for (const [id, timer] of timersRef.current) {
        clearTimeout(timer);
        const patch = pendingPatchRef.current.get(id);
        if (patch) updateTrackerRow(id, patch).catch(() => {});
      }
    };
  }, []);

  async function flushSave(id: string) {
    const patch = pendingPatchRef.current.get(id);
    if (!patch) return;
    pendingPatchRef.current.delete(id);
    timersRef.current.delete(id);

    setSavingIds((prev) => new Set(prev).add(id));
    try {
      const updated = await updateTrackerRow(id, patch);
      setRows((prev) => (prev ? prev.map((r) => (r.id === id ? updated : r)) : prev));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save change");
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function handleEdit(id: string, patch: TrackerRowPatch) {
    // Optimistic local update — the table reflects the edit (and, for
    // Rejected, re-sorts) immediately, before the network round-trip.
    setRows((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, ...patch } : r)) : prev));

    const existing = pendingPatchRef.current.get(id) ?? {};
    pendingPatchRef.current.set(id, { ...existing, ...patch });

    const immediate = Object.keys(patch).some((k) => IMMEDIATE_FIELDS.has(k as keyof TrackerRowPatch));
    const existingTimer = timersRef.current.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    timersRef.current.set(
      id,
      setTimeout(() => flushSave(id), immediate ? 0 : DEBOUNCE_MS)
    );
  }

  async function handleAdd() {
    const url = newUrl.trim();
    if (!url) {
      setActionError("Paste a property URL first.");
      return;
    }
    setAdding(true);
    setActionError(null);
    try {
      const row = await addTrackerRow(url);
      setRows((prev) => [...(prev ?? []), row]);
      setNewUrl("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add property");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Remove this row from the tracker? This can't be undone.")) return;
    const previous = rows;
    setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    try {
      await deleteTrackerRow(id);
    } catch (err) {
      setRows(previous ?? null);
      setActionError(err instanceof Error ? err.message : "Failed to remove row");
    }
  }

  async function handleToggleBackups() {
    const next = !showBackups;
    setShowBackups(next);
    if (next && backups === null) {
      try {
        setBackups(await fetchTrackerBackups());
      } catch (err) {
        setBackupsError(err instanceof Error ? err.message : "Failed to load backups");
      }
    }
  }

  // Destructive — replaces every current row with that day's backup. A
  // native confirm() first, same convention as RefreshHistory's delete
  // button, since this can't be undone.
  async function handleRestore(date: string) {
    if (
      !window.confirm(
        `Restore the tracker to its ${date} backup? This replaces every current row and can't be undone.`
      )
    )
      return;
    setRestoringDate(date);
    setBackupsError(null);
    try {
      const restored = await restoreTrackerBackup(date);
      setRows(restored);
    } catch (err) {
      setBackupsError(err instanceof Error ? err.message : "Failed to restore backup");
    } finally {
      setRestoringDate(null);
    }
  }

  if (!authChecked || !authenticated) return null;

  return (
    <>
      <Header />
      <main className="page-content">
        <h1 className="page-heading">Property Tracker</h1>
        <p className="page-subheading">
          Paste a property listing URL to add it — each page is read live and extracted with AI, the same
          approach as the Compare page: only what a page genuinely states is filled in, anything it
          doesn&apos;t say (or a page that can&apos;t be read) is left blank rather than guessed. Every cell is
          editable. Private to your account — the public can&apos;t see this page.
        </p>

        <div className="tracker-add">
          <input
            type="url"
            className="tracker-add__field"
            placeholder="Paste a property listing URL"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            aria-label="Property URL"
          />
          <button type="button" className="btn btn--primary" onClick={handleAdd} disabled={adding}>
            {adding ? "Adding… this can take a minute" : "Add"}
          </button>
        </div>

        {loadError && <div className="status-banner status-banner--error">{loadError}</div>}
        {actionError && <div className="status-banner status-banner--error">{actionError}</div>}

        <div className="tracker-toolbar">
          {rows && rows.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => exportTrackerToExcel(sortTrackerRows(rows))}
            >
              Export to Excel
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={handleToggleBackups}>
            {showBackups ? "Hide backups" : "Backups"}
          </button>
        </div>

        {showBackups && (
          <div className="tracker-backups">
            <p className="tracker-backups__subtitle">
              A snapshot of the whole tracker is captured automatically once a day. Restoring replaces every
              current row with that day&apos;s snapshot.
            </p>
            {backupsError && <div className="status-banner status-banner--error">{backupsError}</div>}
            {backups === null ? (
              <p className="tracker-backups__loading">Loading backups…</p>
            ) : backups.length === 0 ? (
              <p className="tracker-backups__loading">No backups yet — the first daily backup runs at 07:00.</p>
            ) : (
              <ul className="tracker-backups__list">
                {backups.map((b) => (
                  <li key={b.date} className="tracker-backups__item">
                    <span className="tracker-backups__date">{b.date}</span>
                    <span className="tracker-backups__meta">
                      captured {formatDateTime(b.capturedAt)} · {b.rowCount} row{b.rowCount === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => handleRestore(b.date)}
                      disabled={restoringDate !== null}
                    >
                      {restoringDate === b.date ? "Restoring…" : "Restore"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {rows === null ? (
          <p className="listings-loading">Loading tracker…</p>
        ) : (
          <PropertyTrackerTable rows={rows} onEdit={handleEdit} onDelete={handleDelete} savingIds={savingIds} />
        )}
      </main>
    </>
  );
}
