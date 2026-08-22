"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchStatus, triggerSync } from "@/lib/statusClient";
import { fetchSession } from "@/lib/authClient";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { SourceStatus, SyncStatusRow } from "@/lib/types";
import StatusBadge from "./StatusBadge";

type TabKey = "all" | "updated" | "not_updating" | "blocked" | "errors" | "not_built";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "updated", label: "Updated" },
  { key: "not_updating", label: "Not updating" },
  { key: "blocked", label: "Blocked" },
  { key: "errors", label: "Errors" },
  { key: "not_built", label: "Not built" },
];

function matchesTab(tab: TabKey, status: SourceStatus): boolean {
  switch (tab) {
    case "all":
      return true;
    case "updated":
      return status === "ok";
    case "not_updating":
      return status === "stale" || status === "no_results";
    case "blocked":
      return status === "blocked";
    case "errors":
      return status === "error";
    case "not_built":
      return status === "not_built";
  }
}

// Problems first: blocked/error tie for top priority, then stale, then
// no_results, then healthy sources, then adapters that simply don't exist
// yet — a known gap, not a problem, so it sorts last.
const STATUS_PRIORITY: Record<SourceStatus, number> = {
  blocked: 0,
  error: 0,
  stale: 1,
  no_results: 2,
  ok: 3,
  not_built: 4,
};

export default function StatusMonitorModal({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<SyncStatusRow[] | null>(null);
  const [tab, setTab] = useState<TabKey>("all");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Run sync now" is only ever offered to a logged-in operator — the real
  // protection is server-side (POST /api/sync rejects an unauthenticated
  // request regardless of this), this just avoids showing a button that
  // would only ever come back 401 for a public visitor.
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (!cancelled) setAuthenticated(s.authenticated);
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchStatus();
      setSources(data.sources);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load source status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleRunSync() {
    setSyncing(true);
    setError(null);
    try {
      await triggerSync();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const sorted = useMemo(() => {
    if (!sources) return [];
    return [...sources].sort((a, b) => {
      const diff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
      if (diff !== 0) return diff;
      return a.sourceName.localeCompare(b.sourceName);
    });
  }, [sources]);

  const tabCounts = useMemo(() => {
    const counts: Record<TabKey, number> = {
      all: 0,
      updated: 0,
      not_updating: 0,
      blocked: 0,
      errors: 0,
      not_built: 0,
    };
    for (const s of sorted) {
      for (const t of TABS) {
        if (matchesTab(t.key, s.status)) counts[t.key] += 1;
      }
    }
    return counts;
  }, [sorted]);

  const filtered = useMemo(
    () => sorted.filter((s) => matchesTab(tab, s.status)),
    [sorted, tab]
  );

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-monitor-title"
      >
        <div className="modal__header">
          <h2 id="status-monitor-title">Status Monitor</h2>
          <div className="modal__header-actions">
            {authenticated ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleRunSync}
                disabled={syncing}
              >
                {syncing ? "Syncing…" : "Run sync now"}
              </button>
            ) : (
              <a href="/login" className="btn btn--ghost">
                Log in to sync
              </a>
            )}
            <button
              type="button"
              className="modal__close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="status-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`status-tab${tab === t.key ? " status-tab--active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="status-tab__count">{tabCounts[t.key]}</span>
            </button>
          ))}
        </div>

        <div className="modal__body">
          {error && <div className="status-banner status-banner--error">{error}</div>}

          {loading && !sources ? (
            <div className="status-empty">Loading source status…</div>
          ) : filtered.length === 0 ? (
            <div className="status-empty">No sources in this view.</div>
          ) : (
            <div className="status-table-wrap">
              <table className="status-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Last success</th>
                    <th>Listings found</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr key={s.sourceId}>
                      <td className="status-table__source">{s.sourceName}</td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                      <td>{formatRelativeTime(s.lastSuccessAt)}</td>
                      <td>{s.listingsFound}</td>
                      <td className="status-table__details">
                        {s.errorMessage ? (
                          <span className="status-table__error" title={s.errorMessage}>
                            {s.errorMessage}
                          </span>
                        ) : s.status === "ok" ? (
                          <span className="status-table__muted">
                            +{s.added} added · {s.updated} updated ·{" "}
                            <span className={s.removed > 0 ? "status-table__removed" : undefined}>
                              −{s.removed} removed
                            </span>
                            {s.extractionMethod ? ` · via ${s.extractionMethod}` : ""}
                          </span>
                        ) : (
                          <span className="status-table__muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
