"use client";

import {
  DEFAULT_FILTERS,
  isDefaultFilters,
  type BedroomFilterValue,
  type BedroomTypeFilterValue,
  type ListingFilters,
} from "@/lib/filterListings";
import type { TenureValue } from "@/lib/types";

const BEDROOM_OPTIONS: { value: BedroomFilterValue; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "0", label: "Studio" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4+", label: "4+" },
];

const BEDROOM_TYPE_OPTIONS: { value: BedroomTypeFilterValue; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "single", label: "Single" },
  { value: "double", label: "Double" },
];

const TENURE_OPTIONS: { value: TenureValue; label: string }[] = [
  { value: "share_of_freehold", label: "Share of freehold" },
  { value: "freehold", label: "Freehold" },
  { value: "leasehold", label: "Leasehold" },
  { value: "shared_ownership", label: "Shared ownership" },
];

interface Props {
  filters: ListingFilters;
  onChange: (next: ListingFilters) => void;
  resultCount: number;
  totalCount: number;
}

export default function FilterPanel({ filters, onChange, resultCount, totalCount }: Props) {
  function patch(partial: Partial<ListingFilters>) {
    onChange({ ...filters, ...partial });
  }

  function toggleTenure(value: TenureValue) {
    const next = filters.tenure.includes(value)
      ? filters.tenure.filter((t) => t !== value)
      : [...filters.tenure, value];
    patch({ tenure: next });
  }

  return (
    <section className="filter-panel" aria-label="Filter listings">
      <div className="filter-panel__top">
        <input
          type="text"
          className="filter-search"
          placeholder="Search postcode or area (e.g. SW4, Hackney)"
          value={filters.search}
          onChange={(e) => patch({ search: e.target.value })}
          aria-label="Search postcode or area"
        />
        <div className="filter-panel__count">
          <strong>{resultCount}</strong> of {totalCount} homes
        </div>
      </div>

      <div className="filter-panel__row">
        <div className="filter-group">
          <span className="filter-group__label">Bedrooms</span>
          <div className="filter-pills" role="group" aria-label="Bedrooms">
            {BEDROOM_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`filter-pill${filters.bedrooms === opt.value ? " filter-pill--active" : ""}`}
                aria-pressed={filters.bedrooms === opt.value}
                onClick={() => patch({ bedrooms: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group__label">Bedroom type</span>
          <div className="filter-pills" role="group" aria-label="Bedroom type">
            {BEDROOM_TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`filter-pill${filters.bedroomType === opt.value ? " filter-pill--active" : ""}`}
                aria-pressed={filters.bedroomType === opt.value}
                onClick={() => patch({ bedroomType: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group__label">Price range</span>
          <div className="filter-price-range">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={5000}
              className="filter-number"
              placeholder="Min"
              value={filters.minPrice ?? ""}
              onChange={(e) =>
                patch({ minPrice: e.target.value === "" ? null : Number(e.target.value) })
              }
              aria-label="Minimum price"
            />
            <span className="filter-price-range__sep">–</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={5000}
              className="filter-number"
              placeholder="Max"
              value={filters.maxPrice ?? ""}
              onChange={(e) =>
                patch({ maxPrice: e.target.value === "" ? null : Number(e.target.value) })
              }
              aria-label="Maximum price"
            />
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group__label">Tenure</span>
          <div className="filter-checkboxes" role="group" aria-label="Tenure">
            {TENURE_OPTIONS.map((opt) => (
              <label key={opt.value} className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={filters.tenure.includes(opt.value)}
                  onChange={() => toggleTenure(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group__label">New build</span>
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={filters.newBuildOnly}
              onChange={(e) => patch({ newBuildOnly: e.target.checked })}
            />
            <span className="filter-toggle__track" aria-hidden />
            New build only
          </label>
        </div>

        <button
          type="button"
          className="btn btn--ghost filter-clear"
          onClick={() => onChange(DEFAULT_FILTERS)}
          disabled={isDefaultFilters(filters)}
        >
          Clear filters
        </button>
      </div>
    </section>
  );
}
