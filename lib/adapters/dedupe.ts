/**
 * Cross-source dedup for aggregator adapters (1newhomes, Benhams) — a
 * direct developer's own site always takes priority; an aggregator listing
 * is only kept when it isn't already covered by a direct-developer listing
 * currently in Supabase.
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

interface DirectListingRow {
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

/** Filters `incoming` (one aggregator's freshly-extracted listings) against
 * every currently-active direct-developer listing in Supabase, dropping any
 * that match on name + postcode + price. Reads via the service_role client
 * since this runs as part of the sync job, alongside the write it's about
 * to make. */
export async function dedupeAgainstDirectListings(incoming: AdapterListing[]): Promise<DedupeResult> {
  if (incoming.length === 0) return { kept: [], droppedCount: 0, droppedTitles: [] };

  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("listings")
    .select("title, postcode, price_value")
    .eq("active", true)
    .eq("source_type", "developer")
    .returns<DirectListingRow[]>();
  if (error) {
    throw new Error(`dedupeAgainstDirectListings: failed to read direct-developer listings: ${error.message}`);
  }
  const directListings = data ?? [];

  const kept: AdapterListing[] = [];
  const droppedTitles: string[] = [];
  for (const listing of incoming) {
    const duplicate = directListings.some(
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
