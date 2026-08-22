import type { Listing, TenureValue } from "./types";

export type BedroomFilterValue = "any" | "0" | "1" | "2" | "3" | "4+";
export type BedroomTypeFilterValue = "any" | "single" | "double";

export interface ListingFilters {
  bedrooms: BedroomFilterValue;
  bedroomType: BedroomTypeFilterValue;
  minPrice: number | null;
  maxPrice: number | null;
  /** Empty = no tenure filtering (checkboxes act as an OR filter when checked). */
  tenure: TenureValue[];
  /** Tenures to actively hide, independent of `tenure` above — e.g.
   * "Exclude shared ownership". Empty = nothing excluded. A listing whose
   * tenure is unknown (null) is never excluded by this — excluding is only
   * ever applied to a tenure the source actually stated, never guessed.
   * When a value appears in both `tenure` and `excludeTenure` at once,
   * exclude wins (checked in filterListings after the include check). */
  excludeTenure: TenureValue[];
  newBuildOnly: boolean;
  /** Matched against postcode and area, case-insensitively. */
  search: string;
  /** Selected developer (source) ids to show, checkbox-list semantics:
   *  `null` = default/"all ticked" (no restriction — works even before the
   *  developer list has loaded). An array restricts to exactly those ids,
   *  including `[]` for "Clear all" (every developer unticked → nothing
   *  shown). Unlike `tenure`, empty can't mean "no restriction" here since
   *  the UI needs a real "select none" state distinct from the default. */
  developers: string[] | null;
}

export const DEFAULT_FILTERS: ListingFilters = {
  bedrooms: "any",
  bedroomType: "any",
  minPrice: null,
  maxPrice: null,
  tenure: [],
  excludeTenure: [],
  newBuildOnly: false,
  search: "",
  developers: null,
};

export function filterListings(listings: Listing[], filters: ListingFilters): Listing[] {
  const search = filters.search.trim().toLowerCase();

  return listings.filter((listing) => {
    if (filters.bedrooms !== "any") {
      if (listing.bedrooms === null) return false; // unknown never matches a specific pick
      if (filters.bedrooms === "4+") {
        if (listing.bedrooms < 4) return false;
      } else if (listing.bedrooms !== Number(filters.bedrooms)) {
        return false;
      }
    }

    if (filters.bedroomType !== "any" && listing.bedroomType !== filters.bedroomType) {
      return false;
    }

    if (filters.minPrice != null && listing.priceValue < filters.minPrice) return false;
    if (filters.maxPrice != null && listing.priceValue > filters.maxPrice) return false;

    if (
      filters.tenure.length > 0 &&
      (listing.tenure === null || !filters.tenure.includes(listing.tenure))
    ) {
      return false;
    }

    if (
      filters.excludeTenure.length > 0 &&
      listing.tenure !== null &&
      filters.excludeTenure.includes(listing.tenure)
    ) {
      return false;
    }

    if (filters.newBuildOnly && !listing.isNewBuild) return false;

    if (filters.developers !== null && !filters.developers.includes(listing.sourceId)) {
      return false;
    }

    if (search) {
      const haystack = `${listing.postcode} ${listing.area}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

export function isDefaultFilters(filters: ListingFilters): boolean {
  return (
    filters.bedrooms === "any" &&
    filters.bedroomType === "any" &&
    filters.minPrice == null &&
    filters.maxPrice == null &&
    filters.tenure.length === 0 &&
    filters.excludeTenure.length === 0 &&
    !filters.newBuildOnly &&
    filters.search.trim() === "" &&
    filters.developers === null
  );
}
