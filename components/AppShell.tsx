"use client";

import { useEffect, useMemo, useState } from "react";
import Header from "./Header";
import StatusMonitorModal from "./StatusMonitorModal";
import FilterPanel from "./FilterPanel";
import ListingsGrid from "./ListingsGrid";
import { DEFAULT_FILTERS, filterListings, type ListingFilters } from "@/lib/filterListings";
import type { Listing } from "@/lib/types";

export default function AppShell() {
  const [isStatusOpen, setStatusOpen] = useState(false);
  const [listings, setListings] = useState<Listing[] | null>(null);
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
      </main>
      {isStatusOpen && <StatusMonitorModal onClose={() => setStatusOpen(false)} />}
    </>
  );
}
