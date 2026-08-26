"use client";

import { useEffect, useState } from "react";
import { fetchSyncEvents } from "@/lib/syncEventsClient";
import { formatDateTime } from "@/lib/relativeTime";
import type { SyncEvent } from "@/lib/types";

const EVENT_LABEL: Record<SyncEvent["eventType"], string> = {
  drop_guard_rejected: "Drop guard rejected a removal",
  auto_retry: "Auto-retry",
  auto_lock_clear: "Auto-cleared a stuck lock",
};

/** Every automatic action the sync machinery has taken, real and logged —
 * see lib/dropGuard.ts's logSyncEvent (the only writer) and GET
 * /api/sync-events (the only reader). Deliberately shows every entry
 * exactly as recorded, nothing summarized or estimated — this is the
 * "log every auto-action" requirement made visible in the UI, not just in
 * Supabase. */
export default function AutoActionsLog() {
  const [events, setEvents] = useState<SyncEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSyncEvents(50)
      .then((data) => !cancelled && setEvents(data))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load auto-action log"));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="status-banner status-banner--error">{error}</div>;
  }
  if (events === null) {
    return <div className="status-empty">Loading auto-action log…</div>;
  }
  if (events.length === 0) {
    return (
      <div className="status-empty">
        No automatic actions recorded yet — this fills in the moment the drop guard rejects a removal, a
        source gets auto-retried, or a stuck sync lock gets auto-cleared.
      </div>
    );
  }

  return (
    <ul className="auto-actions-log">
      {events.map((e) => (
        <li key={e.id} className={`auto-actions-log__item auto-actions-log__item--${e.eventType}`}>
          <div className="auto-actions-log__item-header">
            <span className="auto-actions-log__item-type">{EVENT_LABEL[e.eventType]}</span>
            {e.sourceId && <span className="auto-actions-log__item-source">{e.sourceId}</span>}
            <span className="auto-actions-log__item-time">{formatDateTime(e.createdAt)}</span>
          </div>
          <div className="auto-actions-log__item-message">{e.message}</div>
        </li>
      ))}
    </ul>
  );
}
