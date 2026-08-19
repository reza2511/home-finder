"use client";

import { useEffect, useMemo, useState } from "react";
import Header from "./Header";
import StatusMonitorModal from "./StatusMonitorModal";
import FilterPanel from "./FilterPanel";
import DeveloperFilter, { type DeveloperOption } from "./DeveloperFilter";
import ListingsGrid from "./ListingsGrid";
import { DEFAULT_FILTERS, filterListings, type ListingFilters } from "@/lib/filterListings";
import type { Listing } from "@/lib/types";

export default function AppShell() {
  const [isStatusOpen, setStatusOpen] = useState(false);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [developers, setDevelopers] = useState<DeveloperOption[] | null>(null);
  const [filters, setFilters] = useState<ListingFilters>(DEFAULT_FILTERS);

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/developers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setDevelopers(d.developers);
      })
      .catch(() => {
        if (!cancelled) setDevelopers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-developer listing counts, from the full currently-loaded set — not
  // re-narrowed by the other active filters, so the sidebar stays a stable
  // "how many this source currently has" rather than jumping around as
  // price/beds/etc. change (the grid itself still filters live on every
  // change, via `filtered` below).
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const listing of listings ?? []) {
      map[listing.sourceId] = (map[listing.sourceId] ?? 0) + 1;
    }
    return map;
  }, [listings]);

  const filtered = useMemo(
    () => (listings ? filterListings(listings, filters) : []),
    [listings, filters]
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
              developers={developers ?? []}
              loading={developers === null}
              counts={counts}
              selected={filters.developers}
              onChange={(next) => setFilters({ ...filters, developers: next })}
            />
          </aside>

          <div className="page-main">
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              resultCount={filtered.length}
              totalCount={listings?.length ?? 0}
            />

            {listings === null ? (
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
