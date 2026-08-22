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
// through to the default for lack of a negative signal. Kept permissive on
// purpose (a false match here only mislabels an informational field, never
// the `isNewBuild` result itself — see detectIsNewBuild below); do NOT
// reuse this for hasExplicitNewBuildSignal further down, which needs much
// higher precision — see that function's own doc comment for why.
const NEW_BUILD_SIGNAL_RE =
  /\bnew[\s-]?build\b|\bnew[\s-]?home[s]?\b|\boff[\s-]?plan\b|\bnew[\s-]?development\b|\bbrand\s*new\b|\bnewly\s*built\b|\bunder\s*construction\b|\bpractical\s*completion\b|\bcompletion\s*(?:date|due|in)\b|\bshow\s*home\b/i;

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

/**
 * Opposite-default detector, for a general estate-agent source whose stock
 * is predominantly resale (source_type: "estate-agent" — e.g. Winkworth,
 * added 2026-08 explicitly as a test of this resale-filtering approach).
 * Every other source in this file defaults to *include* when uncertain
 * because it's already scoped to new-build-only inventory by construction
 * (see the file-header rationale above) — a general estate agent has no
 * such guarantee, so here the default flips: a listing only counts as new
 * build when its own text carries an explicit, genuine new-build signal.
 * Silence is read as "this is ordinary resale stock", not "assume new
 * build" — per an explicit instruction: when genuinely unsure, exclude.
 *
 * Deliberately does NOT reuse NEW_BUILD_SIGNAL_RE above — that pattern is
 * fine for detectIsNewBuild() (a false match there only mislabels an
 * informational "signal" field; the result is already `true` by default
 * either way), but is far too permissive here, where a false match directly
 * causes a real resale listing to be shown to the user as new build.
 * Calibrated against Winkworth's own live listing text (2026-08): a bare
 * "brand new"/"newly built" overwhelmingly turns out to modify a mundane
 * renovated FEATURE of an ordinary resale property ("brand new kitchen",
 * "brand new boiler", "brand new carpets", "brand new lease") rather than
 * the property or building itself, and bare "new home(s)" is at least as
 * often generic marketing filler ("your new home", "new homes in the
 * area") as a genuine signal — so both require closer confirmation than
 * detectIsNewBuild's list does:
 *   - "new build" / "off-plan" / "show home" / "practical completion" /
 *     "completion date|due|in" are high-precision on their own — kept as-is.
 *     ("new build" and "new development"/"new home(s)" below all allow an
 *     optional hyphen, not just a space — a real live miss otherwise: a
 *     Winkworth new-homes listing describing itself as "a luxurious
 *     one-bedroom new-build property" was wrongly excluded before this,
 *     because the un-hyphenated pattern didn't match "new-build".)
 *   - "new development" / "new home(s)" are kept UNLESS the surrounding
 *     text shows they're about something else (a nearby scheme, or a
 *     generic "find your new home" sign-off).
 *   - "brand new" / "newly built" only count when closely followed by an
 *     actual residential-unit-scale noun (home, apartment, development,
 *     block, ...) rather than a fitting/fixture/legal term — this is what
 *     rules out "brand new kitchen"/"boiler"/"carpets"/"lease" without
 *     needing an ever-growing blacklist of every possible fixture noun.
 *
 * `structuredSignal` lets a caller pass a stronger, source-specific
 * structured field (e.g. Winkworth's own `isDevelopment: true` on a
 * property card) that should count as a genuine signal on its own, the
 * same way detectTenure()'s `forceSharedOwnership` opt works — a real
 * field the source itself publishes, not a guess layered on top of it.
 */
const HIGH_PRECISION_NEW_BUILD_RE =
  /\bnew[\s-]?build\b|\boff[\s-]?plan\b|\bshow\s*home\b|\bpractical\s*completion\b|\bcompletion\s*(?:date|due|in)\b/i;

const NEW_DEVELOPMENT_OR_HOME_RE = /\bnew[\s-]?development\b|\bnew[\s-]?home[s]?\b/i;

// Neutralizes a "new development"/"new home(s)" match that's really about
// something OTHER than this specific listing — a nearby/area-wide scheme,
// or a generic real-estate sign-off ("your new home", "find your new
// home") rather than a stated fact about this property or its building.
const NEW_DEVELOPMENT_OR_HOME_FALSE_POSITIVE_RE =
  /\b(?:in\s+the\s+area|nearby|locally|close\s+by|near(?:by)?|in\s+the\s+locality)\s+(?:new[\s-]?development|new[\s-]?home[s]?)\b|\b(?:new[\s-]?development|new[\s-]?home[s]?)\s+(?:in\s+the\s+area|nearby|locally)\b|\byour\s+new\s+home\b|\b(?:perfect|dream|ideal|forever|next)\s+new\s+home\b|\bfind\s+your\s+new\s+home\b|\bmake\s+(?:this|it)\b[^.]{0,40}\byour\s+new\s+home\b/i;

// A residential-unit-scale noun — what "brand new"/"newly built" must be
// describing for either phrase to count (see doc comment above).
const RESIDENTIAL_UNIT_NOUN_SOURCE =
  "(?:homes?|houses?|apartments?|flats?|properties|residences?|developments?|builds?|blocks?|schemes?|mews\\s+houses?)";
const BRAND_NEW_OR_NEWLY_BUILT_RE = new RegExp(
  `\\b(?:brand[\\s-]?new|newly\\s*built)\\b(?:\\s+\\S+){0,6}?\\s+${RESIDENTIAL_UNIT_NOUN_SOURCE}\\b`,
  "i"
);

export function hasExplicitNewBuildSignal(
  text: string | null | undefined,
  opts?: { structuredSignal?: boolean }
): boolean {
  if (opts?.structuredSignal) return true;
  if (!text) return false;
  if (HIGH_PRECISION_NEW_BUILD_RE.test(text)) return true;
  if (NEW_DEVELOPMENT_OR_HOME_RE.test(text) && !NEW_DEVELOPMENT_OR_HOME_FALSE_POSITIVE_RE.test(text)) return true;
  if (BRAND_NEW_OR_NEWLY_BUILT_RE.test(text)) return true;
  return false;
}
