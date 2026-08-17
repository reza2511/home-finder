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
  newBuildOnly: boolean;
  /** Matched against postcode and area, case-insensitively. */
  search: string;
}

export const DEFAULT_FILTERS: ListingFilters = {
  bedrooms: "any",
  bedroomType: "any",
  minPrice: null,
  maxPrice: null,
  tenure: [],
  newBuildOnly: false,
  search: "",
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

    if (filters.newBuildOnly && !listing.isNewBuild) return false;

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
    !filters.newBuildOnly &&
    filters.search.trim() === ""
  );
}
