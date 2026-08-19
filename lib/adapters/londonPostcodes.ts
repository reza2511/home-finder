/**
 * Shared "is this a London postcode?" helper — used by the generic
 * auto-adapter's discovered-URL path (autoAdapter.ts) and the dedicated L&Q
 * adapter (lqHomes.ts), so both agree on the same definition rather than
 * drifting apart.
 *
 * Outward-code area letters that are actually London (inner: E, EC, N, NW,
 * SE, SW, W, WC; outer-London post towns: BR, CR, DA, EN, HA, IG, KT, RM,
 * SM, TW, UB, WD — a few of these straddle Greater London's boundary, which
 * is an accepted imprecision for a heuristic, not a fabrication). Plenty of
 * real UK postcodes (e.g. Bellway's Eastern Counties homes, L&Q's Reading/
 * Preston/Manchester developments) fall outside this set entirely — being a
 * valid UK postcode is not the same as being a London one.
 */
export const LONDON_POSTCODE_AREAS = new Set([
  "E", "EC", "N", "NW", "SE", "SW", "W", "WC",
  "BR", "CR", "DA", "EN", "HA", "IG", "KT", "RM", "SM", "TW", "UB", "WD",
]);

// A full UK postcode (outward + inward, e.g. "SE3 9DN").
export const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i;

// Just the outward/district code (e.g. "UB3"), for addresses that only
// publish that much (seen live on L&Q's Hayes Village listing).
export const UK_OUTWARD_CODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

/** True if `postcode` (full or outward-only) falls in a London area. */
export function postcodeAreaIsLondon(postcode: string): boolean {
  const pc = postcode.trim().toUpperCase();
  if (!pc) return false;
  if (!UK_POSTCODE_RE.test(pc) && !UK_OUTWARD_CODE_RE.test(pc)) return false;
  const area = pc.match(/^([A-Z]{1,2})\d/)?.[1] ?? "";
  return LONDON_POSTCODE_AREAS.has(area);
}
