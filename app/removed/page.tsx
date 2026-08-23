"use client";

import { useEffect, useMemo, useState } from "react";
import Header from "@/components/Header";
import TimeRangeFilter from "@/components/TimeRangeFilter";
import RemovedListingsGrid from "@/components/RemovedListingsGrid";
import {
  DEFAULT_REMOVED_TIME_RANGE_ID,
  REMOVED_TIME_RANGES,
  removedTimeRangeCutoff,
} from "@/lib/removedTimeRanges";
import type { RemovedListing } from "@/lib/types";

// Public — no login required, no auth check/redirect (unlike /compare or
// /favourites). GET /api/removed is itself unauthenticated too.
export default function RemovedItemsPage() {
  const [listings, setListings] = useState<RemovedListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeId, setRangeId] = useState(DEFAULT_REMOVED_TIME_RANGE_ID);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/removed", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) {
          setError(d.error);
          setListings([]);
        } else {
          setListings(d.listings);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load removed listings.");
          setListings([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRange = REMOVED_TIME_RANGES.find((r) => r.id === rangeId) ?? REMOVED_TIME_RANGES[0];

  // Every range's count, from the one already-loaded set (fetched once,
  // capped server-side at the widest range offered — see GET
  // /api/removed) — same convention as AppShell's areaQuickFilterCounts.
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const range of REMOVED_TIME_RANGES) result[range.id] = 0;
    if (!listings) return result;
    for (const range of REMOVED_TIME_RANGES) {
      const cutoff = removedTimeRangeCutoff(range.days).getTime();
      result[range.id] = listings.filter((l) => Date.parse(l.removedAt) >= cutoff).length;
    }
    return result;
  }, [listings]);

  const filtered = useMemo(() => {
    if (!listings) return [];
    const cutoff = removedTimeRangeCutoff(selectedRange.days).getTime();
    return listings
      .filter((l) => Date.parse(l.removedAt) >= cutoff)
      // Already sorted removed_at desc by the API, but the client-side
      // range filter doesn't change order — re-sort defensively so this
      // page's own ordering guarantee never silently depends on the API's.
      .sort((a, b) => Date.parse(b.removedAt) - Date.parse(a.removedAt));
  }, [listings, selectedRange]);

  return (
    <>
      <Header />
      <main className="page-content">
        <h1 className="page-heading">Removed items</h1>
        <p className="page-subheading">
          Listings that have vanished from their source since the last sync that saw them — likely
          sold or withdrawn. Real removal data only: a listing only appears here once a sync has
          actually detected it&apos;s gone.
        </p>

        <TimeRangeFilter selected={rangeId} onChange={setRangeId} counts={counts} />

        {error && <div className="status-banner status-banner--error">{error}</div>}

        {listings === null ? (
          <p className="listings-empty">Loading…</p>
        ) : (
          <>
            <p className="removed-items__count">
              {filtered.length} listing{filtered.length === 1 ? "" : "s"} removed in the last{" "}
              {selectedRange.shortLabel}
            </p>
            <RemovedListingsGrid listings={filtered} />
          </>
        )}
      </main>
    </>
  );
}
