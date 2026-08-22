/**
 * Cross-source dedup for every second-phase (non-direct-developer) adapter
 * — aggregators (1newhomes, Benhams) and general estate agents (Winkworth,
 * Hamptons, Knight Frank, Renowned Homes, Benhams London) alike. A direct
 * developer's own site always takes priority; a second-phase source's
 * listing is only kept when it isn't already covered by ANY other
 * currently-active listing in Supabase — a direct developer's, or another
 * second-phase source's (2026-08: extended from "direct developers only" to
 * this, per explicit instruction — the estate-agent sources overlap with
 * each other at least as much as with direct developers, e.g. the two
 * Benhams pages/new-homes and /london/ cover much of the same stock).
 *
 * This only works correctly because runAllAdapters() (syncEngine.ts) runs
 * every second-phase source SEQUENTIALLY, not in parallel — each one's
 * dedupe query needs to see every earlier second-phase source's
 * already-written rows from the SAME sync run, not just direct developers'.
 * Among second-phase sources, whichever one runs (and is therefore stored)
 * first wins a duplicate — driven by registration order in
 * london-developers.json / lib/adapters/index.ts.
 *
 * "Match on development name + postcode + price, allowing small
 * differences" is implemented as ALL THREE of:
 *   - name:     normalized (lowercased, punctuation stripped) substring
 *               containment either way, or at least one shared significant
 *               token after stripping common stop-words ("the", "new",
 *               "london", "homes", ...) — catches "Trillium" vs "Trillium,
 *               Marylebone, W2" or "The Verdean" vs "Verdean, Acton".
 *   - postcode: compared by OUTWARD code only (e.g. "SW18" from either
 *               "SW18" or "SW18 4JQ") — an aggregator card often only
 *               publishes the district, not the full postcode, so
 *               requiring an exact full-postcode match would silently
 *               never dedupe anything.
 *   - price:    within 5% of each other — aggregators and developers don't
 *               always show the exact same figure at the exact same time
 *               (rounding, a since-updated price, share vs full price).
 *
 * All three must match — this is deliberately conservative. A listing
 * missing postcode data entirely (confirmed live: 1newhomes' list-card
 * markup never publishes one) can never be confirmed as a duplicate through
 * this check and is always kept — never assuming a match without real
 * postcode evidence, same "never guess" rule every adapter in this app
 * follows for its own extracted fields.
 */
import { requireSupabaseAdmin } from "../db";
import type { AdapterListing } from "./types";

interface ActiveListingRow {
  title: string;
  postcode: string | null;
  price_value: number;
}

const STOP_WORDS = new Set([
  "the", "at", "a", "an", "new", "homes", "home", "development", "developments",
  "apartments", "apartment", "london", "show",
]);

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((t) => t.length > 2 && !STOP_WORDS.has(t)));
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = significantTokens(na);
  const tb = significantTokens(nb);
  for (const token of ta) {
    if (tb.has(token)) return true;
  }
  return false;
}

function outwardCode(postcode: string | null | undefined): string {
  const pc = (postcode ?? "").trim().toUpperCase();
  const spaceIdx = pc.indexOf(" ");
  return spaceIdx === -1 ? pc : pc.slice(0, spaceIdx);
}

function postcodesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const oa = outwardCode(a);
  const ob = outwardCode(b);
  return !!oa && !!ob && oa === ob;
}

const PRICE_TOLERANCE_RATIO = 0.05; // 5%

function pricesMatch(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= Math.max(a, b) * PRICE_TOLERANCE_RATIO;
}

export interface DedupeResult {
  kept: AdapterListing[];
  droppedCount: number;
  droppedTitles: string[];
}

/** Filters `incoming` (one second-phase source's freshly-extracted
 * listings) against every OTHER currently-active listing in Supabase —
 * direct developers' and every other second-phase source's alike (see file
 * header) — dropping any that match on name + postcode + price.
 * `currentSourceId` excludes that source's own previously-active rows from
 * the comparison (a source should never dedupe against its own prior run).
 * Reads via the service_role client since this runs as part of the sync
 * job, alongside the write it's about to make. */
export async function dedupeAgainstActiveListings(
  incoming: AdapterListing[],
  currentSourceId: string
): Promise<DedupeResult> {
  if (incoming.length === 0) return { kept: [], droppedCount: 0, droppedTitles: [] };

  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("listings")
    .select("title, postcode, price_value")
    .eq("active", true)
    .neq("source_id", currentSourceId)
    .returns<ActiveListingRow[]>();
  if (error) {
    throw new Error(`dedupeAgainstActiveListings(${currentSourceId}): failed to read active listings: ${error.message}`);
  }
  const otherListings = data ?? [];

  const kept: AdapterListing[] = [];
  const droppedTitles: string[] = [];
  for (const listing of incoming) {
    const duplicate = otherListings.some(
      (d) =>
        postcodesMatch(d.postcode, listing.postcode) &&
        namesMatch(d.title, listing.title) &&
        pricesMatch(d.price_value, listing.priceValue)
    );
    if (duplicate) {
      droppedTitles.push(listing.title);
    } else {
      kept.push(listing);
    }
  }

  return { kept, droppedCount: droppedTitles.length, droppedTitles };
}
