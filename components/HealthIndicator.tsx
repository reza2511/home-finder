"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHealth, acknowledgeDropGuard } from "@/lib/healthClient";
import type { HealthResponse } from "@/lib/types";

const POLL_INTERVAL_MS = 60_000;

/**
 * The Green/Red health sign, next to Clear cache / Status Monitor in
 * Header.tsx. GET /api/health does the actual computing (drop guard,
 * a stuck run, an unexpectedly-empty source group, a source's last run
 * failing — see that route's own doc comment); this component just polls
 * it and renders the result. Hover shows the first reason as a native
 * tooltip; click opens a small popover with the full list and, when a
 * problem needs a human (`needsAttention`) and the viewer is logged in,
 * an Acknowledge action — see app/api/health/acknowledge/route.ts for what
 * that does and doesn't do.
 */
export default function HealthIndicator({ authenticated }: { authenticated: boolean }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [acking, setAcking] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchHealth();
      setHealth(data);
    } catch {
      // Best-effort indicator, same convention as Header.tsx's own status
      // polling — a failed health check must never itself read as an
      // incident; it just quietly doesn't update until the next poll.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (!cancelled) await load();
    }
    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function handleAcknowledge() {
    setAcking(true);
    setAckError(null);
    try {
      await acknowledgeDropGuard();
      await load();
    } catch (e) {
      setAckError(e instanceof Error ? e.message : "Failed to acknowledge");
    } finally {
      setAcking(false);
    }
  }

  if (!health) {
    return (
      <span className="health-sign health-sign--idle" title="Checking site health…">
        <span className="health-sign__dot" aria-hidden />
        Checking…
      </span>
    );
  }

  const isRed = health.status === "red";
  const label = isRed ? (health.needsAttention ? "Needs attention" : "Unhealthy") : "Healthy";
  const summary = health.reasons[0] ?? (isRed ? "Something needs a look." : "All good.");

  return (
    <div className="health-sign-wrap" ref={containerRef}>
      <button
        type="button"
        className={`health-sign health-sign--${isRed ? (health.needsAttention ? "attention" : "danger") : "ok"}`}
        title={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="health-sign__dot" aria-hidden />
        {label}
      </button>
      {open && (
        <div className="health-sign__popover" role="dialog" aria-label="Site health detail">
          <div className="health-sign__popover-title">
            {isRed ? "🔴" : "🟢"} {label}
          </div>
          <ul className="health-sign__reasons">
            {health.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {health.needsAttention && (
            <div className="health-sign__attention">
              This needs a human decision — nothing here will auto-retry or auto-delete anything.
              {authenticated ? (
                <button
                  type="button"
                  className="btn btn--ghost health-sign__ack-btn"
                  onClick={handleAcknowledge}
                  disabled={acking}
                >
                  {acking ? "Clearing…" : "Acknowledge & clear"}
                </button>
              ) : (
                <span className="health-sign__ack-hint">Log in to acknowledge.</span>
              )}
              {ackError && <div className="health-sign__ack-error">{ackError}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
