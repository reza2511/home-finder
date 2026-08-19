"use client";

import { useMemo, useState } from "react";

export interface DeveloperOption {
  id: string;
  name: string;
}

interface Props {
  developers: DeveloperOption[];
  /** True until the developer list has loaded — distinguishes "still
   * loading" from "loaded, but none currently have listings". */
  loading: boolean;
  /** Listing count per developer id, from the currently loaded listings
   * (independent of the other active filters — see AppShell). */
  counts: Record<string, number>;
  /** `null` = all ticked (default). See ListingFilters.developers. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
}

export default function DeveloperFilter({ developers, loading, counts, selected, onChange }: Props) {
  const [search, setSearch] = useState("");

  const isChecked = (id: string) => selected === null || selected.includes(id);

  function toggle(id: string) {
    if (selected === null) {
      // Coming from the implicit "all" state — express it explicitly, minus
      // the one just unticked.
      onChange(developers.map((d) => d.id).filter((otherId) => otherId !== id));
      return;
    }
    onChange(
      selected.includes(id) ? selected.filter((otherId) => otherId !== id) : [...selected, id]
    );
  }

  // Hidden entirely (not just greyed) so the list isn't cluttered with
  // sources that currently have nothing to show — per developer, not
  // per search match, so typing in the search box never un-hides one.
  const withListings = useMemo(
    () => developers.filter((d) => (counts[d.id] ?? 0) > 0),
    [developers, counts]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return withListings;
    return withListings.filter((d) => d.name.toLowerCase().includes(q));
  }, [withListings, search]);

  return (
    <section className="dev-filter" aria-label="Filter by developer">
      <h2 className="dev-filter__heading">Developers</h2>

      <input
        type="text"
        className="dev-filter__search"
        placeholder="Search developers…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search developers"
      />

      <div className="dev-filter__actions">
        <button type="button" className="dev-filter__link" onClick={() => onChange(null)}>
          Select all
        </button>
        <span className="dev-filter__link-sep" aria-hidden>
          ·
        </span>
        <button type="button" className="dev-filter__link" onClick={() => onChange([])}>
          Clear all
        </button>
      </div>

      <div className="dev-filter__list">
        {loading ? (
          <p className="dev-filter__empty">Loading developers…</p>
        ) : withListings.length === 0 ? (
          <p className="dev-filter__empty">No developers with listings yet.</p>
        ) : visible.length === 0 ? (
          <p className="dev-filter__empty">No developers match &quot;{search}&quot;.</p>
        ) : (
          visible.map((d) => (
            <label key={d.id} className="dev-filter__item">
              <input
                type="checkbox"
                checked={isChecked(d.id)}
                onChange={() => toggle(d.id)}
              />
              <span className="dev-filter__name">{d.name}</span>
              <span className="dev-filter__count">{counts[d.id] ?? 0}</span>
            </label>
          ))
        )}
      </div>
    </section>
  );
}
