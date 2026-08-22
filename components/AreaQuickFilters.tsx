"use client";

import { AREA_QUICK_FILTERS } from "@/lib/areaQuickFilters";

interface Props {
  /** Currently active button id, or null. See ListingFilters.areaQuickFilter. */
  selected: string | null;
  onChange: (next: string | null) => void;
  /** Match count per button id, from the currently loaded listings with
   * every OTHER active filter already applied (not just the raw unfiltered
   * total) — see AppShell's own useMemo for why. */
  counts: Record<string, number>;
}

/**
 * Sidebar shortcut buttons that filter the grid by area — composes with
 * every other filter in FilterPanel rather than replacing any of them (see
 * lib/filterListings.ts). Clicking the already-active button clears it.
 *
 * To add another button: add one entry to AREA_QUICK_FILTERS in
 * lib/areaQuickFilters.ts — nothing here needs to change.
 */
export default function AreaQuickFilters({ selected, onChange, counts }: Props) {
  return (
    <section className="dev-filter" aria-label="Area quick filters">
      <h2 className="dev-filter__heading">Area quick filters</h2>
      <div className="area-quick-filters__list">
        {AREA_QUICK_FILTERS.map((f) => {
          const active = selected === f.id;
          return (
            <button
              key={f.id}
              type="button"
              className={`filter-pill area-quick-filters__pill${active ? " filter-pill--active" : ""}`}
              aria-pressed={active}
              onClick={() => onChange(active ? null : f.id)}
            >
              <span>{f.label}</span>
              <span className="dev-filter__count">{counts[f.id] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
