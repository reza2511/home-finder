import { UK_OUTWARD_CODE_RE } from "./adapters/londonPostcodes";

/**
 * Real, well-documented UK postcode area names — not invented. The eight
 * inner-London compass-direction names (E/EC/N/NW/SE/SW/W/WC) come from
 * the historical London postal district scheme (each area is literally
 * "London" + a compass suffix — see
 * https://en.wikipedia.org/wiki/London_postal_district); the twelve outer
 * areas are their official Royal Mail post towns (see
 * https://en.wikipedia.org/wiki/List_of_postcode_districts_in_the_United_Kingdom).
 * Exactly the same 20 areas as lib/adapters/londonPostcodes.ts's
 * LONDON_POSTCODE_AREAS — kept in sync deliberately, both lists describe
 * the same real-world set.
 */
export const POSTCODE_AREA_NAMES: Record<string, string> = {
  E: "East London",
  EC: "East Central London",
  N: "North London",
  NW: "North West London",
  SE: "South East London",
  SW: "South West London",
  W: "West London",
  WC: "West Central London",
  BR: "Bromley",
  CR: "Croydon",
  DA: "Dartford",
  EN: "Enfield",
  HA: "Harrow",
  IG: "Ilford",
  KT: "Kingston upon Thames",
  RM: "Romford",
  SM: "Sutton",
  TW: "Twickenham",
  UB: "Uxbridge",
  WD: "Watford",
};

/**
 * Extracts the outward/district code (e.g. "SW20", "EC1A") from a full or
 * outward-only UK postcode string — the exact granularity the boundary
 * data (public/data/postcode-districts.geojson) and GET
 * /api/postcode-counts key their district codes by. Returns null for
 * anything that doesn't look like a real UK postcode, rather than
 * guessing — a listing with no usable postcode simply isn't counted
 * anywhere on the map, not mis-attributed to one.
 */
export function extractDistrictCode(postcode: string): string | null {
  const trimmed = postcode.trim().toUpperCase();
  if (!trimmed) return null;
  // Full postcode ("SW20 9AN") — take the outward half; already-outward-
  // only postcodes ("UB3") pass straight through.
  const outward = trimmed.split(/\s+/)[0];
  return UK_OUTWARD_CODE_RE.test(outward) ? outward : null;
}
