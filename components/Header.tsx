"use client";

import { useEffect, useState } from "react";
import { fetchStatus } from "@/lib/statusClient";
import type { StatusSummary } from "@/lib/types";

export default function Header({ onOpenStatus }: { onOpenStatus: () => void }) {
  const [summary, setSummary] = useState<StatusSummary | null>(null);

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
      <div className="app-header__brand">
        <span className="app-header__logo" aria-hidden>
          🏠
        </span>
        <span className="app-header__title">Home Finder</span>
      </div>
      <div className="app-header__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onOpenStatus}
          aria-haspopup="dialog"
        >
          <span className={`status-dot status-dot--${dotModifier}`} aria-hidden />
          Status Monitor
        </button>
      </div>
    </header>
  );
}
