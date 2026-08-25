"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchSyncHistory } from "@/lib/syncHistoryClient";
import { formatDateTime } from "@/lib/relativeTime";
import type { SyncRunLog } from "@/lib/types";
import StatusBadge from "./StatusBadge";

const TRIGGERED_BY_LABEL: Record<string, string> = {
  "github-actions": "Daily sync (GitHub Actions)",
  "vercel-manual": "Manual (Run sync now)",
};

// A source's "kept" count (added + updated — i.e. how many of its listings
// were active at the end of that run) is flagged when it drops to less
// than half of what the SAME source kept in the immediately preceding
// fetched run. Both numbers are real, already-stored counts from two real
// runs — this only ever compares them, never invents or estimates either
// side — so it's a real signal ("this source's count collapsed right
// here") rather than a guess at why.
const DROP_FLAG_RATIO = 0.5;

function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** Real, stored per-run sync history (GET /api/sync-history) — most recent
 * run first, each with its own per-source added/updated/removed/kept.
 * Lets a real count change (e.g. 1200 -> 1360 -> 1450) be told apart from a
 * bug (one source alone collapsing) by comparing actual runs against each
 * other, never by guessing or fabricating a number that wasn't stored. */
export default function SyncHistoryView() {
  const [runs, setRuns] = useState<SyncRunLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSyncHistory(3)
      .then((data) => !cancelled && setRuns(data))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load sync history"));
    return () => {
      cancelled = true;
    };
  }, []);

  // sourceId -> kept count, for the run immediately after (older than) each
  // run — built once so each run only has to look up its own predecessor.
  const previousKeptBySourceId = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    if (!runs) return map;
    for (let i = 0; i < runs.length - 1; i++) {
      const prev = runs[i + 1];
      const kept = new Map<string, number>();
      for (const s of prev.sources) kept.set(s.sourceId, s.added + s.updated);
      map.set(runs[i].id, kept);
    }
    return map;
  }, [runs]);

  if (error) {
    return <div className="status-banner status-banner--error">{error}</div>;
  }
  if (runs === null) {
    return <div className="status-empty">Loading sync history…</div>;
  }
  if (runs.length === 0) {
    return <div className="status-empty">No sync runs logged yet — this starts recording from the next sync.</div>;
  }

  return (
    <div className="sync-history">
      {runs.map((run, index) => {
        const prevRun = runs[index + 1];
        const totalDelta =
          run.totalActiveCount != null && prevRun?.totalActiveCount != null
            ? run.totalActiveCount - prevRun.totalActiveCount
            : null;
        const prevKept = previousKeptBySourceId.get(run.id);

        return (
          <section key={run.id} className="sync-history__run">
            <div className="sync-history__run-header">
              <div>
                <strong>{formatDateTime(run.startedAt)}</strong>
                <span className="status-table__muted"> · {TRIGGERED_BY_LABEL[run.triggeredBy] ?? run.triggeredBy}</span>
              </div>
              <div className="sync-history__run-total">
                {run.totalActiveCount != null ? (
                  <>
                    <strong>{run.totalActiveCount.toLocaleString()}</strong> active
                    {totalDelta != null && totalDelta !== 0 && (
                      <span
                        className={
                          totalDelta > 0 ? "sync-history__delta sync-history__delta--up" : "sync-history__delta sync-history__delta--down"
                        }
                      >
                        {" "}
                        ({formatSigned(totalDelta)} vs previous run)
                      </span>
                    )}
                  </>
                ) : (
                  <span className="status-table__muted">Run incomplete — no total recorded</span>
                )}
              </div>
            </div>

            <div className="status-table-wrap">
              <table className="status-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Added</th>
                    <th>Updated</th>
                    <th>Removed</th>
                    <th>Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {run.sources.map((s) => {
                    const kept = s.added + s.updated;
                    const prev = prevKept?.get(s.sourceId);
                    const flagged = prev != null && prev > 0 && kept < prev * DROP_FLAG_RATIO;
                    return (
                      <tr key={s.sourceId}>
                        <td className="status-table__source">{s.sourceName}</td>
                        <td>
                          <StatusBadge status={s.status} />
                        </td>
                        <td>{s.added}</td>
                        <td>{s.updated}</td>
                        <td className={s.removed > 0 ? "status-table__removed" : undefined}>{s.removed}</td>
                        <td>
                          <span
                            className={flagged ? "sync-history__kept sync-history__kept--flagged" : "sync-history__kept"}
                            title={
                              flagged
                                ? `Dropped from ${prev} to ${kept} vs the previous run — check this source`
                                : undefined
                            }
                          >
                            {kept}
                            {flagged && " ⚠"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
