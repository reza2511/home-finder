"use client";

import { REMOVED_TIME_RANGES } from "@/lib/removedTimeRanges";

interface Props {
  selected: string;
  onChange: (id: string) => void;
  /** Match count per range id, from the full removed-listings set already
   * loaded (not a separate fetch per range) — see AppShell's
   * areaQuickFilterCounts for the same convention on the live grid. */
  counts: Record<string, number>;
}

/** Time-range pills for the Removed items page — reuses the same
 * .filter-pill styling AreaQuickFilters uses on the live grid. Exactly one
 * of REMOVED_TIME_RANGES is ever selected (unlike AreaQuickFilters, which
 * can be cleared back to "none"). */
export default function TimeRangeFilter({ selected, onChange, counts }: Props) {
  return (
    <section className="dev-filter" aria-label="Time range">
      <h2 className="dev-filter__heading">Removed in the last</h2>
      <div className="area-quick-filters__list">
        {REMOVED_TIME_RANGES.map((range) => {
          const active = selected === range.id;
          return (
            <button
              key={range.id}
              type="button"
              className={`filter-pill area-quick-filters__pill${active ? " filter-pill--active" : ""}`}
              aria-pressed={active}
              onClick={() => onChange(range.id)}
            >
              <span>{range.label}</span>
              <span className="dev-filter__count">{counts[range.id] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
