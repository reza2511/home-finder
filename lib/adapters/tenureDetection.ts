/**
 * Shared tenure-detection logic — used by the generic auto-adapter
 * (autoAdapter.ts), the dedicated L&Q adapter (lqHomes.ts), and Taylor
 * Wimpey London (taylorWimpeyLondon.ts), so every adapter classifies
 * "shared ownership" the same way instead of drifting apart.
 *
 * Shared ownership is a distinct tenure category from `leasehold` in this
 * app (see FilterPanel's tenure checkboxes) even though a shared-ownership
 * home is very often *structurally* leasehold too — sites frequently label
 * the same plot "Leasehold" in one field and "Shared Ownership" in another
 * (confirmed live on L&Q: `plot_type: "shared_ownership"` alongside
 * `plot_tenure: "Leasehold"` on the same plot). Detection here always
 * checks for shared ownership first and lets it win, so a listing is never
 * wrongly grouped under plain `leasehold` just because the page also uses
 * that word.
 */
import type { AdapterListing, TenureValue } from "./types";

// Also matches "share)" (the closing-paren form this app's own adapters use
// when formatting a share price, e.g. "£67,500 share (25% share) — full
// value £270,000") and "full value"/"full price" (which only ever appears
// on a listing to show a share price against the full home value) — both
// added after a real miss: an L&Q listing whose own `plot_tenure` field
// said "Leasehold" needed catching by its *display text* alone, as a second
// line of defense independent of any adapter's own structured-field logic
// (see applySharedOwnershipOverride below).
const SHARED_OWNERSHIP_RE =
  /shared[\s-]?ownership|part\s*buy,?\s*part\s*rent|\b\d{1,3}\s?%\s*share\b|share\)|full\s*(?:value|price)/i;
const SHARE_OF_FREEHOLD_RE = /share of freehold|share-of-freehold/i;
const LEASEHOLD_RE = /leasehold/i;
const FREEHOLD_RE = /freehold/i;

/**
 * Detects tenure from free text. Checks for shared ownership first (a
 * share-percentage mention, "shared ownership"/"shared-ownership", or
 * "part buy part rent") — if found, returns "shared_ownership" regardless
 * of whether the same text also says "leasehold". Falls through to
 * share-of-freehold, leasehold, then freehold. Returns null rather than
 * guessing when nothing matches.
 *
 * `forceSharedOwnership` lets a caller pass a stronger, source-specific
 * structured signal (e.g. L&Q's own `plot_type === "shared_ownership"`
 * field, or a developer directory entry whose only published tenure is
 * "shared-ownership") that should win outright, without needing that
 * signal to also appear in the free text.
 */
export function detectTenure(
  text: string | null | undefined,
  opts?: { forceSharedOwnership?: boolean }
): TenureValue | null {
  if (opts?.forceSharedOwnership) return "shared_ownership";
  if (!text) return null;
  if (SHARED_OWNERSHIP_RE.test(text)) return "shared_ownership";
  if (SHARE_OF_FREEHOLD_RE.test(text)) return "share_of_freehold";
  if (LEASEHOLD_RE.test(text)) return "leasehold";
  if (FREEHOLD_RE.test(text)) return "freehold";
  return null;
}

/** True if a developer's directory entry (london-developers.json) shows
 * shared ownership as its *only* published tenure/scheme — e.g. Guinness
 * Homes, MTVH, SO Resi, SNG, Hyde New Homes, Sage Homes. For these, every
 * listing really is shared ownership even when a specific listing's own
 * page never uses the words, so the generic auto-adapter forces it rather
 * than relying on per-listing text (see finalizeListings in
 * autoAdapter.ts). Developers offering shared ownership *alongside* other
 * schemes (e.g. L&Q, Peabody) are deliberately excluded here — those need
 * real per-listing detection, not a blanket assumption. */
export function isExclusivelySharedOwnershipProvider(tenures: string[] | undefined): boolean {
  return !!tenures && tenures.length === 1 && tenures[0] === "shared-ownership";
}

// Developer ids explicitly named as shared-ownership providers. Used only
// as a *tie-breaker* in applySharedOwnershipOverride below, not an
// unconditional relabel — several of these (L&Q, Peabody, Clarion/Latimer,
// NHG, A2Dominion) also genuinely sell some homes outright or freehold,
// stated unambiguously by the source's own data (e.g. L&Q's own
// `plot_type: "private_sale"`, confirmed live) — overriding *that* to
// shared_ownership would be fabricating a false tenure for a real listing,
// not fixing one, which is exactly what "real data only, never fake" rules
// out. It only tips a listing whose tenure is otherwise unstated (null).
export const SHARED_OWNERSHIP_PROVIDER_IDS = new Set([
  "lq-homes",
  "peabody-new-homes",
  "clarion-latimer",
  "nhg-homes",
  "so-resi",
  "sng-homes",
  "hyde-new-homes",
  "guinness-homes",
  "mtvh",
  "a2dominion",
  "sage-homes",
]);

/**
 * Post-adapter normalization pass: applied to every listing from every
 * source, right after adapter.run() and before it's stored (see runOne()
 * in syncEngine.ts) — a second, source-independent line of defense so a
 * gap in any single adapter's own tenure logic can't let a shared-ownership
 * listing slip through mislabelled (e.g. as plain "leasehold"), rather than
 * relying solely on each adapter getting it right internally.
 *
 * Forces tenure = "shared_ownership", overriding whatever the adapter set
 * (including an explicit "leasehold"/"freehold"), whenever the listing's
 * own display text (price, priceRange, title — what a shopper actually
 * sees) carries a shared-ownership signal. A known shared-ownership
 * provider only breaks a tie when the adapter left tenure unstated (null);
 * it never overrides a tenure the source explicitly stated to be something
 * else — see SHARED_OWNERSHIP_PROVIDER_IDS's own comment for why.
 */
export function applySharedOwnershipOverride(listing: AdapterListing, sourceId: string): AdapterListing {
  if (listing.tenure === "shared_ownership") return listing; // already correct

  const haystack = `${listing.price} ${listing.priceRange ?? ""} ${listing.title}`;
  const hasTextSignal = SHARED_OWNERSHIP_RE.test(haystack);
  const isUnstatedFromKnownProvider = listing.tenure === null && SHARED_OWNERSHIP_PROVIDER_IDS.has(sourceId);

  if (hasTextSignal || isUnstatedFromKnownProvider) {
    return { ...listing, tenure: "shared_ownership" };
  }
  return listing;
}
