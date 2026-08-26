"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStatus } from "@/lib/statusClient";
import { fetchSession, logout } from "@/lib/authClient";
import { clearCache } from "@/lib/cacheClient";
import HamburgerMenu from "./HamburgerMenu";
import HealthIndicator from "./HealthIndicator";
import type { StatusSummary } from "@/lib/types";

// onOpenStatus is optional so pages other than the home page (e.g.
// /compare) can reuse the same header/nav without needing a Status Monitor
// modal to wire up — the button itself just doesn't render without it.
// onClearCache is likewise optional: only the home page actually has
// listings to re-fetch, so the "Clear cache" button just doesn't render
// anywhere else (same convention as onOpenStatus, right next to it).
export default function Header({
  onOpenStatus,
  onClearCache,
}: {
  onOpenStatus?: () => void;
  onClearCache?: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<StatusSummary | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const clearedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setSummary(data.summary);
    } catch {
      // Best-effort indicator only — the modal itself surfaces load errors.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!cancelled) await loadStatus();
    }
    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadStatus]);

  useEffect(() => {
    return () => {
      if (clearedTimeoutRef.current) clearTimeout(clearedTimeoutRef.current);
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

  // Hits POST /api/cache/clear (a real revalidatePath() call — see that
  // route's own comment on what it actually purges today), then forces a
  // fresh re-fetch of both this header's own status summary and, via
  // onClearCache, the page's live listings — so a click genuinely re-reads
  // the database end to end rather than just showing a confirmation and
  // hoping the next automatic poll happens to pick up a change.
  async function handleClearCache() {
    setClearingCache(true);
    try {
      await clearCache();
      await Promise.all([loadStatus(), onClearCache?.()]);
      setCacheCleared(true);
      if (clearedTimeoutRef.current) clearTimeout(clearedTimeoutRef.current);
      clearedTimeoutRef.current = setTimeout(() => setCacheCleared(false), 2500);
    } catch {
      // Best-effort — the button itself is a convenience; a failed clear
      // just means the next automatic poll/refresh catches up as usual.
    } finally {
      setClearingCache(false);
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
        <HealthIndicator authenticated={authenticated} />
        {onClearCache && (
          <span className="clear-cache">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleClearCache}
              disabled={clearingCache}
              title="Force the live site to re-fetch everything fresh from the database"
            >
              {clearingCache ? "Clearing…" : "Clear cache"}
            </button>
            {cacheCleared && (
              <span className="clear-cache__confirm" role="status">
                Cache cleared ✓
              </span>
            )}
          </span>
        )}
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
