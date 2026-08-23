import type { Listing } from "./types";

/**
 * "Area quick filter" buttons — a single-select shortcut layered on top of
 * every other filter in lib/filterListings.ts (postcode search, bedrooms,
 * tenure, developers, ...), not a replacement for any of them: filterListings()
 * applies this as just one more AND condition alongside all the others, so
 * a quick filter always combines with whatever else is set. A listing
 * matches a quick filter when EITHER its postcode falls in one of
 * `postcodePrefixes` OR its `area` names one of `areaNames` — real data on
 * both sides, never guessed.
 *
 * Two groups, rendered as two sections by components/AreaQuickFilters.tsx:
 * `"postcode"` (real London postcode-area/borough shortcuts) and `"line"`
 * (tube/rail line shortcuts — approximate, see LINE_APPROXIMATION_NOTE).
 * `parentId` marks the 11 individual NW1–NW11 buttons as sub-filters of
 * the "NW London" button — the UI only reveals them once NW London itself
 * is selected, so the default view isn't cluttered with all 11 at once.
 *
 * To add another button later: add one more entry to AREA_QUICK_FILTERS
 * below (set `group` and, for a sub-filter, `parentId`). Nothing else needs
 * to change — AreaQuickFilters/filterListings both just read this array.
 */
export interface AreaQuickFilter {
  id: string;
  label: string;
  group: "postcode" | "line";
  /** Set only on a sub-filter (e.g. each NW1–NW11 button under "NW
   * London") — the UI only shows it once the filter with this id is
   * itself selected. */
  parentId?: string;
  /** Outward-code prefixes (e.g. "NW9" for one specific district, "NW" for
   * every NW1–NW11 district) — matched against the listing's own outward
   * code, never a raw substring of the full postcode string. A prefix
   * ending in a digit only matches that exact district, never a longer
   * one that happens to start the same way (see outwardMatchesPrefix) —
   * e.g. "HA1" matches HA1 but never HA10-and-up if such a district
   * existed, and "W1" matches every real W1-lettered sub-district
   * (W1B, W1C, ...) but never W10/W11. */
  postcodePrefixes: string[];
  /** Real place names, matched against `listing.area` as a WHOLE
   * comma-separated segment (case-insensitively) — e.g. "Plot 94 Barton
   * Apartment Harrow View, Harrow, HA1" has a "Harrow" segment and matches,
   * but "Edgware Road" or "Harrow Manorway" (real street names that merely
   * contain the word) do not, since neither is its own segment equal to
   * the target name. Line filters intentionally leave this empty — see
   * their own comment below. */
  areaNames: string[];
}

export const LINE_APPROXIMATION_NOTE =
  "Approximate: matches listings by the real postcode districts this line's stations fall in, not each property's actual walking distance to a station.";

export const AREA_QUICK_FILTERS: AreaQuickFilter[] = [
  // ---------- Postcode-based ----------
  {
    id: "colindale",
    label: "Colindale",
    group: "postcode",
    postcodePrefixes: ["NW9"],
    areaNames: ["Colindale"],
  },
  {
    id: "nw-postcode",
    label: "NW Postcode",
    group: "postcode",
    postcodePrefixes: ["NW"],
    areaNames: [],
  },
  {
    id: "nw-london",
    label: "NW London",
    group: "postcode",
    // NW1–NW11 — the real, current NW postcode area (11 districts; there
    // is no NW26 or higher district in the real NW postcode area, despite
    // that being asked for — see the reply this was built alongside).
    postcodePrefixes: ["NW"],
    areaNames: [],
  },
  // The 11 individual NW1–NW11 sub-filters — real place names for each,
  // shown only once "NW London" (above) is selected.
  { id: "nw1", label: "NW1 · Camden / Regent's Park", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW1"], areaNames: [] },
  { id: "nw2", label: "NW2 · Cricklewood / Dollis Hill", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW2"], areaNames: [] },
  { id: "nw3", label: "NW3 · Hampstead / Swiss Cottage", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW3"], areaNames: [] },
  { id: "nw4", label: "NW4 · Hendon / Brent Cross", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW4"], areaNames: [] },
  { id: "nw5", label: "NW5 · Kentish Town", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW5"], areaNames: [] },
  { id: "nw6", label: "NW6 · Kilburn / West Hampstead", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW6"], areaNames: [] },
  { id: "nw7", label: "NW7 · Mill Hill / Arkley", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW7"], areaNames: [] },
  { id: "nw8", label: "NW8 · St John's Wood", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW8"], areaNames: [] },
  { id: "nw9", label: "NW9 · Colindale / Kingsbury / The Hyde", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW9"], areaNames: [] },
  { id: "nw10", label: "NW10 · Willesden / Harlesden / Kensal Green", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW10"], areaNames: [] },
  { id: "nw11", label: "NW11 · Golders Green", group: "postcode", parentId: "nw-london", postcodePrefixes: ["NW11"], areaNames: [] },
  {
    id: "watford",
    label: "Watford",
    group: "postcode",
    postcodePrefixes: ["WD6", "WD7", "WD17", "WD18", "WD24"],
    areaNames: [],
  },
  {
    id: "barnet",
    label: "Barnet",
    group: "postcode",
    // The London Borough of Barnet's real postcode footprint — spans
    // parts of N, NW, EN and HA (a borough boundary, not a single
    // postcode area, which is why this list is longer than the others).
    postcodePrefixes: ["N2", "N3", "N11", "N12", "N20", "EN4", "EN5", "NW4", "NW7", "NW9", "NW11", "HA8"],
    areaNames: ["Barnet"],
  },
  {
    id: "wembley",
    label: "Wembley",
    group: "postcode",
    postcodePrefixes: ["HA9"],
    areaNames: ["Wembley"],
  },
  {
    id: "harrow",
    label: "Harrow",
    group: "postcode",
    // Deliberately HA1/HA2/HA3/HA7 only — HA9 (Wembley) and HA8 (Edgware)
    // have their own separate buttons above/below, and no area-name match
    // is added here either, so this can never pick up a Wembley/Edgware
    // listing via that path.
    postcodePrefixes: ["HA1", "HA2", "HA3", "HA7"],
    areaNames: [],
  },
  {
    id: "edgware",
    label: "Edgware",
    group: "postcode",
    postcodePrefixes: ["HA8"],
    areaNames: ["Edgware"],
  },

  // ---------- Tube/rail line-based (approximate — see LINE_APPROXIMATION_NOTE) ----------
  {
    id: "line-northern",
    label: "Northern line",
    group: "line",
    postcodePrefixes: [
      "EN5", "N20", "N12", "N3", "N2", "N6", "N19", "N7", "N1",
      "NW1", "NW3", "NW4", "NW5", "NW7", "NW9", "NW11",
      "EC1", "EC2", "EC4", "WC2",
      "SE1", "SE11", "SW4", "SW8", "SW9", "SW12", "SW17", "SW19",
      "SM4", "HA8",
    ],
    areaNames: [],
  },
  {
    id: "line-jubilee",
    label: "Jubilee line",
    group: "line",
    postcodePrefixes: [
      "HA7", "HA9", "NW9", "NW10", "NW6", "NW8", "NW1",
      "W1", "SW1", "SE1", "SE16", "E14", "SE10", "E16", "E15", "E20",
    ],
    areaNames: [],
  },
  {
    id: "line-bakerloo",
    label: "Bakerloo line",
    group: "line",
    postcodePrefixes: ["HA3", "HA9", "HA0", "NW10", "NW6", "W2", "NW1", "W1", "WC2", "SE1"],
    areaNames: [],
  },
  {
    id: "line-elizabeth",
    label: "Elizabeth line",
    group: "line",
    postcodePrefixes: ["UB1", "UB2", "UB3", "W5", "W13", "W2", "W1", "WC1", "EC1", "EC2", "E1", "E14", "E16", "SE18", "SE2"],
    areaNames: [],
  },
  {
    id: "line-metropolitan",
    label: "Metropolitan line",
    group: "line",
    postcodePrefixes: ["WD17", "WD18", "WD3", "HA6", "HA5", "HA1", "HA3", "HA9", "NW3", "NW1", "EC3", "W1"],
    areaNames: [],
  },
  {
    id: "line-piccadilly",
    label: "Piccadilly line",
    group: "line",
    postcodePrefixes: [
      "UB8", "UB10", "HA4", "HA5", "HA2",
      "W3", "W6", "SW5", "SW7", "SW1", "W1", "WC2", "WC1",
      "N1", "N7", "N5", "N4",
    ],
    areaNames: [],
  },
  {
    id: "line-lioness",
    label: "Lioness line (Watford–Euston)",
    group: "line",
    postcodePrefixes: ["WD17", "WD18", "WD23", "WD19", "HA5", "HA3", "HA9", "HA0", "NW10", "NW6", "NW1"],
    areaNames: [],
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
 * "NW10"/"NW11", and "W1" matches every real lettered W1 sub-district
 * (W1B, W1C, ...) but never W10/W11. */
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
