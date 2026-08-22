"use client";

import { useEffect, useState } from "react";
import { fetchStatus } from "@/lib/statusClient";
import { fetchSession, logout } from "@/lib/authClient";
import HamburgerMenu from "./HamburgerMenu";
import type { StatusSummary } from "@/lib/types";

// onOpenStatus is optional so pages other than the home page (e.g.
// /compare) can reuse the same header/nav without needing a Status Monitor
// modal to wire up — the button itself just doesn't render without it.
export default function Header({ onOpenStatus }: { onOpenStatus?: () => void }) {
  const [summary, setSummary] = useState<StatusSummary | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchStatus();
        if (!cancelled) setSummary(data.summary);
      } catch {
        // Best-effort indicator only — the modal itself surfaces load errors.
      }
    }

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      // Full reload so every "am I logged in" bit of state (this header,
      // the Status Monitor's sync button) re-derives from the now-cleared
      // cookie, rather than trying to hand-reset each piece individually.
      window.location.href = "/";
    }
  }

  const hasProblems = !!summary && (summary.blocked > 0 || summary.error > 0);
  const hasWarnings = !!summary && (summary.stale > 0 || summary.no_results > 0);
  const dotModifier = !summary
    ? "idle"
    : hasProblems
      ? "danger"
      : hasWarnings
        ? "warn"
        : "ok";

  return (
    <header className="app-header">
      <div className="app-header__left">
        <HamburgerMenu />
        <div className="app-header__brand">
          <span className="app-header__logo" aria-hidden>
            🏠
          </span>
          <span className="app-header__title">Home Finder</span>
        </div>
      </div>
      <div className="app-header__actions">
        {onOpenStatus && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onOpenStatus}
            aria-haspopup="dialog"
          >
            <span className={`status-dot status-dot--${dotModifier}`} aria-hidden />
            Status Monitor
          </button>
        )}
        {authenticated ? (
          <button type="button" className="btn btn--ghost" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        ) : (
          <a href="/login" className="btn btn--ghost">
            Log in
          </a>
        )}
      </div>
    </header>
  );
}
