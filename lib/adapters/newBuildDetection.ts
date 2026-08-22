/**
 * Shared new-build detection — used by every adapter in this app instead of
 * each hardcoding `isNewBuild: true` on every listing unconditionally (an
 * earlier version of this codebase did exactly that everywhere, which
 * technically worked today only because every currently-configured source
 * in london-developers.json genuinely is a new-build-only developer or a
 * "new homes" aggregator — but it was never actually *derived* from
 * anything on the page, just assumed, which is the "unreliable" flag this
 * function replaces).
 *
 * Every one of this app's real sources (Barratt, Redrow, Taylor Wimpey,
 * Bellway, Ballymore, Countryside, Berkeley, Fairview, L&Q, Peabody,
 * Guinness — direct new-build housebuilders/housing associations that
 * don't sell resale stock on their own sites at all — plus 1newhomes and
 * Benhams, both scoped specifically to new-build developments) is, by its
 * own nature, exclusively new-build. So the correct default here — and the
 * one explicitly required — is to treat a listing AS new build unless its
 * own text contains a clear, unambiguous resale/older-property signal.
 * "Can't tell" is never treated as a reason to exclude a real new-build
 * listing from the "New build only" filter.
 */
import type { AdapterListing } from "./types";

// Deliberately narrow and explicit — phrases that only really appear when a
// listing is genuinely NOT a new build (a resale of an existing/older
// property), not just the *absence* of a "new build" mention (most of this
// app's own structured plot data never bothers to say "new build" either,
// since the entire site it came from already only sells new homes).
const RESALE_SIGNAL_RE =
  /\bresale\b|\bresold\b|\bre-sale\b|\bpre-?owned\b|\bpreviously\s+owned\b|\bsecond-?hand\b|\bexisting\s+(?:home|property|house)\b|\bnot\s+a\s+new\s*[- ]?build\b|\bolder\s+(?:property|home|house)\b|\bperiod\s+(?:property|home|conversion)\b/i;

// A genuine positive statement is never required to return true (the
// default already is), but recognising one explicitly means a listing that
// says so is grounded in real, present wording rather than just falling
// through to the default for lack of a negative signal.
const NEW_BUILD_SIGNAL_RE =
  /\bnew\s*build\b|\bnew\s*home[s]?\b|\boff[\s-]?plan\b|\bbrand\s*new\b|\bnewly\s*built\b|\bunder\s*construction\b|\bpractical\s*completion\b|\bcompletion\s*(?:date|due|in)\b|\bshow\s*home\b/i;

export type NewBuildSignal = "explicit_new_build" | "resale_signal" | "assumed_new_build_source";

/**
 * Determines new-build status from real text (a listing's own title,
 * description, or any other free text an adapter has genuinely extracted
 * from the page) — never a blanket assumption with nothing behind it.
 *
 * - A clear resale/older-property phrase → false. This is the ONLY way to
 *   get `false` — everything else defaults to true.
 * - An explicit "new build"/"off-plan"/etc. phrase → true, with a real
 *   signal behind it (not just the default).
 * - No text, or text with neither signal → true anyway (err toward
 *   inclusion, per the explicit rule: never wrongly exclude a real
 *   new-build listing just because this particular page didn't happen to
 *   use the words).
 */
export function detectIsNewBuild(text: string | null | undefined): { isNewBuild: boolean; signal: NewBuildSignal } {
  if (text && RESALE_SIGNAL_RE.test(text)) {
    return { isNewBuild: false, signal: "resale_signal" };
  }
  if (text && NEW_BUILD_SIGNAL_RE.test(text)) {
    return { isNewBuild: true, signal: "explicit_new_build" };
  }
  return { isNewBuild: true, signal: "assumed_new_build_source" };
}

/**
 * Post-adapter normalization pass, mirroring applySharedOwnershipOverride
 * in tenureDetection.ts — applied to every listing from every source right
 * after adapter.run() (see runOne() in syncEngine.ts), as a second,
 * source-independent line of defense. Re-checks the listing's own display
 * text (title + price + priceRange, what a shopper actually sees) for a
 * resale signal even if the adapter itself already set isNewBuild — a gap
 * in one adapter's own per-listing text-checking can't let an actual
 * resale slip through mislabelled as new build. Never flips true→false
 * without a real signal in that text, and never flips an adapter's
 * explicit false back to true (a real resale signal found earlier stands).
 */
export function applyNewBuildOverride(listing: AdapterListing): AdapterListing {
  if (!listing.isNewBuild) return listing; // already correctly flagged not-new-build
  const haystack = `${listing.title} ${listing.price} ${listing.priceRange ?? ""}`;
  if (RESALE_SIGNAL_RE.test(haystack)) {
    return { ...listing, isNewBuild: false };
  }
  return listing;
}
