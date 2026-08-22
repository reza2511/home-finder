"use client";

import { useEffect, useMemo, useState } from "react";
import Header from "./Header";
import StatusMonitorModal from "./StatusMonitorModal";
import FilterPanel from "./FilterPanel";
import DeveloperFilter, { type DeveloperOption } from "./DeveloperFilter";
import RefreshHistory from "./RefreshHistory";
import ListingsGrid from "./ListingsGrid";
import { DEFAULT_FILTERS, filterListings, type ListingFilters } from "@/lib/filterListings";
import { formatDateTime } from "@/lib/relativeTime";
import type { HistorySnapshotDetail } from "@/lib/historyClient";
import type { Listing } from "@/lib/types";

export default function AppShell() {
  const [isStatusOpen, setStatusOpen] = useState(false);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [filters, setFilters] = useState<ListingFilters>(DEFAULT_FILTERS);
  // null = viewing live listings (the normal case). Set by clicking a
  // Refresh History button — everything below (developer options, counts,
  // filtering, the grid) reads from `activeListings`, so a recalled
  // snapshot flows through the exact same pipeline live data does.
  const [historySnapshot, setHistorySnapshot] = useState<HistorySnapshotDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/listings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setListings(d.listings);
      })
      .catch(() => {
        if (!cancelled) setListings([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeListings = historySnapshot ? historySnapshot.listings : listings;

  // The developer filter's id→name list and per-developer counts are BOTH
  // derived straight from the currently-loaded listings — never from a
  // separate list (there used to be a GET /api/developers backed by
  // london-developers.json, kept in sync with actual listings by hand).
  // That's what let the sidebar drift out of sync with reality: a source
  // could have real, active listings and still not show a tickbox if that
  // separate list didn't happen to have a matching id. Deriving both from
  // `listings` itself — which already carries the exact `sourceId`/
  // `sourceName` every adapter wrote (see app/api/listings/route.ts's own
  // join against sync_status, which gets its source_name directly from
  // adapter.name at sync time, not from any JSON file) — makes that
  // mismatch structurally impossible: any source with at least one active
  // listing appears automatically, with the exact name it was actually
  // synced under, and any source with zero listings simply isn't in this
  // data at all, so there's nothing to filter out separately.
  const { developerOptions, counts } = useMemo(() => {
    const nameById = new Map<string, string>();
    const countById: Record<string, number> = {};
    for (const listing of activeListings ?? []) {
      countById[listing.sourceId] = (countById[listing.sourceId] ?? 0) + 1;
      if (!nameById.has(listing.sourceId)) nameById.set(listing.sourceId, listing.sourceName);
    }
    const options: DeveloperOption[] = [...nameById.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { developerOptions: options, counts: countById };
  }, [activeListings]);

  const filtered = useMemo(
    () => (activeListings ? filterListings(activeListings, filters) : []),
    [activeListings, filters]
  );

  return (
    <>
      <Header onOpenStatus={() => setStatusOpen(true)} />
      <main className="page-content">
        <h1 className="page-heading">Find your next home</h1>
        <p className="page-subheading">
          Aggregated from every connected source. Check the Status Monitor if a source
          looks quiet.
        </p>

        <div className="page-layout">
          <aside className="page-sidebar">
            <DeveloperFilter
              developers={developerOptions}
              loading={activeListings === null}
              counts={counts}
              selected={filters.developers}
              onChange={(next) => setFilters({ ...filters, developers: next })}
            />
            <RefreshHistory
              activeSnapshotId={historySnapshot?.id ?? null}
              onSelect={setHistorySnapshot}
            />
          </aside>

          <div className="page-main">
            {historySnapshot && (
              <div className="history-banner">
                <span>
                  Viewing a saved snapshot from <strong>{formatDateTime(historySnapshot.runStartedAt)}</strong>
                  {" "}(captured {formatDateTime(historySnapshot.capturedAt)}) — not live data.
                </span>
                <button type="button" className="btn btn--ghost" onClick={() => setHistorySnapshot(null)}>
                  Return to live listings
                </button>
              </div>
            )}

            <FilterPanel
              filters={filters}
              onChange={setFilters}
              resultCount={filtered.length}
              totalCount={activeListings?.length ?? 0}
            />

            {activeListings === null ? (
              <p className="listings-loading">Loading listings…</p>
            ) : (
              <ListingsGrid listings={filtered} />
            )}
          </div>
        </div>
      </main>
      {isStatusOpen && <StatusMonitorModal onClose={() => setStatusOpen(false)} />}
    </>
  );
}
