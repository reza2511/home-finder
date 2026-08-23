"use client";

import { AREA_QUICK_FILTERS, LINE_APPROXIMATION_NOTE, type AreaQuickFilter } from "@/lib/areaQuickFilters";

interface Props {
  /** Currently active button id, or null. See ListingFilters.areaQuickFilter. */
  selected: string | null;
  onChange: (next: string | null) => void;
  /** Match count per button id, from the currently loaded listings —
   * independent of every other active filter, same convention as
   * DeveloperFilter's own counts (so a button's number always answers "how
   * many listings are in this area at all", not "... given what else is
   * ticked right now"). */
  counts: Record<string, number>;
}

function QuickFilterButton({
  filter,
  active,
  count,
  onClick,
}: {
  filter: AreaQuickFilter;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`filter-pill area-quick-filters__pill${active ? " filter-pill--active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span>{filter.label}</span>
      <span className="dev-filter__count">{count}</span>
    </button>
  );
}

/**
 * Sidebar shortcut buttons that filter the grid by area — composes with
 * every other filter in FilterPanel rather than replacing any of them (see
 * lib/filterListings.ts). Clicking the already-active button clears it;
 * clicking a different one replaces the selection (single-select).
 *
 * Two sections: real postcode-area/borough shortcuts, and approximate
 * tube/rail line shortcuts (see LINE_APPROXIMATION_NOTE). The 11
 * individual NW1–NW11 buttons only appear once "NW London" itself is
 * selected — see their `parentId` in lib/areaQuickFilters.ts.
 *
 * To add another button: add one entry to AREA_QUICK_FILTERS in
 * lib/areaQuickFilters.ts — nothing here needs to change.
 */
export default function AreaQuickFilters({ selected, onChange, counts }: Props) {
  function handleClick(id: string) {
    onChange(selected === id ? null : id);
  }

  const postcodeFilters = AREA_QUICK_FILTERS.filter((f) => f.group === "postcode" && !f.parentId);
  const lineFilters = AREA_QUICK_FILTERS.filter((f) => f.group === "line");
  const activeSubFilters = AREA_QUICK_FILTERS.filter((f) => f.parentId && f.parentId === selected);

  return (
    <section className="dev-filter" aria-label="Area quick filters">
      <h2 className="dev-filter__heading">Postcode areas</h2>
      <div className="area-quick-filters__list">
        {postcodeFilters.map((f) => (
          <QuickFilterButton
            key={f.id}
            filter={f}
            active={selected === f.id}
            count={counts[f.id] ?? 0}
            onClick={() => handleClick(f.id)}
          />
        ))}
      </div>

      {activeSubFilters.length > 0 && (
        <div className="area-quick-filters__sublist">
          {activeSubFilters.map((f) => (
            <QuickFilterButton
              key={f.id}
              filter={f}
              active={selected === f.id}
              count={counts[f.id] ?? 0}
              onClick={() => handleClick(f.id)}
            />
          ))}
        </div>
      )}

      <h2 className="dev-filter__heading area-quick-filters__lines-heading">
        Tube / rail lines
        <span className="area-quick-filters__info" title={LINE_APPROXIMATION_NOTE} aria-label={LINE_APPROXIMATION_NOTE}>
          ⓘ
        </span>
      </h2>
      <div className="area-quick-filters__list">
        {lineFilters.map((f) => (
          <QuickFilterButton
            key={f.id}
            filter={f}
            active={selected === f.id}
            count={counts[f.id] ?? 0}
            onClick={() => handleClick(f.id)}
          />
        ))}
      </div>
    </section>
  );
}
