import type { Listing } from "./types";

/**
 * "Area quick filter" buttons — a single-select shortcut layered on top of
 * every other filter in lib/filterListings.ts (postcode search, bedrooms,
 * tenure, developers, ...), not a replacement for any of them. A listing
 * matches a quick filter when EITHER its postcode falls in one of
 * `postcodePrefixes` OR its `area` names one of `areaNames` — real data on
 * both sides, never guessed.
 *
 * To add another button later: add one more entry to AREA_QUICK_FILTERS
 * below. Nothing else needs to change — FilterPanel/AreaQuickFilters render
 * this array directly, and filterListings() looks a selected id up in it.
 */
export interface AreaQuickFilter {
  id: string;
  label: string;
  /** Outward-code prefixes (e.g. "NW9" for one specific district, "NW" for
   * every NW1–NW11 district, "HA"/"WD" for every district in that postal
   * area) — matched against the listing's own outward code, never a raw
   * substring of the full postcode string. */
  postcodePrefixes: string[];
  /** Real place names, matched against `listing.area` as a WHOLE
   * comma-separated segment (case-insensitively) — e.g. "Plot 94 Barton
   * Apartment Harrow View, Harrow, HA1" has a "Harrow" segment and matches,
   * but "Edgware Road" or "Harrow Manorway" (real street names that merely
   * contain the word) do not, since neither is its own segment equal to
   * the target name. This is what keeps street names out per the "match on
   * area name, not street names containing the word" requirement. */
  areaNames: string[];
}

export const AREA_QUICK_FILTERS: AreaQuickFilter[] = [
  {
    id: "colindale",
    label: "Colindale",
    postcodePrefixes: ["NW9"],
    areaNames: ["Colindale"],
  },
  {
    id: "nw-postcode",
    label: "NW Postcode",
    postcodePrefixes: ["NW"],
    areaNames: [],
  },
  {
    id: "nw-london",
    label: "North West London",
    postcodePrefixes: ["NW", "HA", "WD"],
    areaNames: ["Harrow", "Watford", "Wembley", "Edgware", "Stanmore", "Pinner"],
  },
];

// The outward/district code at the start of a UK postcode, e.g. "NW9 5HU"
// -> "NW9", "SE14 5QA" -> "SE14", or a bare outward-only value ("NW9") ->
// "NW9" unchanged. Empty/unparseable input yields "" — never guessed.
const OUTWARD_CODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?)/;

function outwardCode(postcode: string | null | undefined): string {
  const m = (postcode ?? "").trim().toUpperCase().match(OUTWARD_CODE_RE);
  return m ? m[1] : "";
}

/** True if `outward` (already the district code, e.g. "NW9") falls under
 * `prefix` (e.g. "NW9" or just the area letters "NW"). A pure-letters
 * prefix matches every district in that area; a prefix that itself ends in
 * a digit (a specific district) requires the next character, if any, to
 * NOT continue that digit run — so "NW1" can never accidentally also match
 * "NW10"/"NW11". */
function outwardMatchesPrefix(outward: string, prefix: string): boolean {
  const p = prefix.toUpperCase();
  if (!outward.startsWith(p)) return false;
  if (/\d$/.test(p)) {
    const nextChar = outward[p.length];
    return nextChar === undefined || !/\d/.test(nextChar);
  }
  return true;
}

/** True if `area` has a comma-separated segment that, trimmed and
 * lowercased, exactly equals one of `areaNames` — see the field doc above
 * for why this is a whole-segment match rather than `.includes()`. */
function areaHasNameSegment(area: string | null | undefined, areaNames: string[]): boolean {
  if (areaNames.length === 0) return false;
  const segments = (area ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (segments.length === 0) return false;
  const targets = new Set(areaNames.map((n) => n.toLowerCase()));
  return segments.some((seg) => targets.has(seg));
}

/** True if `listing` matches this quick filter — postcode prefix OR area
 * name, either is enough (see AreaQuickFilter's own doc comment). */
export function listingMatchesAreaQuickFilter(listing: Listing, filter: AreaQuickFilter): boolean {
  const outward = outwardCode(listing.postcode);
  if (outward && filter.postcodePrefixes.some((p) => outwardMatchesPrefix(outward, p))) return true;
  return areaHasNameSegment(listing.area, filter.areaNames);
}
