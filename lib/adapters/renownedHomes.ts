/**
 * Dedicated adapter for Renowned Homes (renowned-homes.co.uk) — a general
 * new-homes estate agent/aggregator, NOT a developer's own site
 * (source_type: "estate-agent" in london-developers.json,
 * trustAsNewBuild: true — see file footer). No mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery):
 *
 *   https://www.renowned-homes.co.uk/property-for-sale?price_max=450000
 *
 * robots.txt (https://renowned-homes.co.uk/robots.txt, checked 2026-08):
 * `Allow: /`, only `/studio` and `/api/` disallowed — neither matches this
 * page or its pagination.
 *
 * CRITICAL — network-json feed check: confirmed live by capturing this
 * page's own network traffic (Playwright response listener) across a full
 * load — this is a Next.js App Router site; the only xhr/fetch requests
 * fired are Next.js's own internal React Server Component prefetch
 * payloads (`?_rsc=...`, triggered by hover-prefetching nearby links) and
 * third-party analytics. An RSC payload is not a stable, parseable JSON
 * listings feed (React's own "Flight" wire format, not documented/public
 * JSON), and isn't needed anyway — the search-results page itself
 * server-renders full real card markup directly in the initial HTML
 * (`.dev_card` anchors: developer name, development title, "N bed · area"
 * text, a real "From £X" price, and a real CDN image URL, confirmed live).
 * No network-json feed; extractionMethod: "html-pagination".
 *
 * CRITICAL — pagination: real, query-string based — `?price_max=450000&
 * page=N` (confirmed live: a real `href="?price_max=450000&page=2"` link,
 * and the page's own numbered pager going up to `page=13`). Walked by
 * fetching each page directly through the same Playwright session
 * (`page.request.get()`) until a page returns 0 cards or the safety cap is
 * hit.
 *
 * Each card is one row per DEVELOPMENT (its own lead "From £X" price), not
 * one row per individual home — same documented, accepted limitation as
 * this app's own Countryside adapter (lib/adapters/countryside.ts) for the
 * identical reason: that's what this list page itself publishes.
 * `bedrooms` is only ever filled in when the card's own "N bed" text states
 * a single count — never guessed for "1-3 bed" style text.
 *
 * Postcode: NOT published on the list card itself (only a human-readable
 * area name after the "·", e.g. "Poplar", "Greenwich") — but IS published
 * on each development's own detail page, inside its `<meta name=
 * "description">` tag (e.g. "...Inglis Way Millbrook Park Mill Hill
 * London, NW7 1RY. Prices from £425,000...", confirmed live) — fetched
 * once per listing (same session, no full render) specifically for this,
 * since the CRITICAL dedupe requirement below needs a real postcode to
 * match against. Left blank rather than guessed if that page's own meta
 * description doesn't contain a real UK postcode.
 *
 * CRITICAL — London only: this source's own URL (`price_max=450000`) is a
 * UK-WIDE price filter, not a London one at all — confirmed live, the
 * page's own `<title>` reads "Homes for Sale in the UK", and real results
 * genuinely include Maidenhead, Slough, and Brentwood (none of them London
 * or Greater London). So, unlike Hamptons/Knight Frank (whose own URLs
 * really are London-scoped searches), this adapter can't trust the URL at
 * all here — every card is kept only when its real fetched postcode is a
 * London area (lib/adapters/londonPostcodes.ts), or "London" appears in
 * its own name/area text, same backstop this app's other aggregator-style
 * adapters already apply (1newhomes, Benhams).
 *
 * Tenure: this list/detail combination never states tenure directly
 * (checked live) — `detectTenure()` still runs over the card's own meta
 * text/description, same "real text, never guessed" rule as every other
 * adapter; comes back null on this source in practice.
 *
 * trustAsNewBuild: true (this entry) — every development card collected
 * here is kept and stored as `isNewBuild: true`, no per-listing new-build
 * signal-checking — this is Renowned Homes' own "new homes" catalog by
 * construction (every developer shown — Taylor Wimpey, EcoWorld, Berkeley,
 * etc. — sells new-build only).
 *
 * CRITICAL — dedupe: many of these developments are the SAME real stock
 * this app's own direct-developer adapters already cover (Taylor Wimpey,
 * Berkeley, ...) — being a non-direct source, this adapter's output is
 * deduped against every other currently-active listing (direct developers'
 * AND every other second-phase source's) before being stored — see
 * lib/adapters/dedupe.ts and lib/syncEngine.ts's isSecondPhaseSource /
 * sequential second-phase ordering.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectTenure } from "./tenureDetection";
import { postcodeAreaIsLondon } from "./londonPostcodes";
import { withBrowser } from "./browser";

// Same character-class shape as UK_POSTCODE_RE (lib/adapters/londonPostcodes.ts)
// but WITHOUT its `^...$` anchors — that version only matches when the
// *entire* string is a postcode, which never happens here: the real
// postcode sits mid-sentence inside a `<meta name="description">` value
// (e.g. "...Mill Hill London, NW7 1RY. Prices from £425,000..."), so it
// needs to be found within the text, not matched against the whole of it.
const EMBEDDED_UK_POSTCODE_RE = /[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/i;

const SOURCE_ID = "renowned-homes";
const BASE_URL = "https://www.renowned-homes.co.uk";
const TARGET_URL = `${BASE_URL}/property-for-sale?price_max=450000`;
const GOTO_TIMEOUT_MS = 60_000;
const CARD_SELECTOR = "a.dev_card";
const MAX_PAGES = 40; // real total confirmed live: 13 pages — capped well above that
const PAGE_FETCH_DELAY_MS = 300;
const DETAIL_FETCH_DELAY_MS = 250; // be a polite crawler across dozens of per-listing detail fetches

interface ParsedCard {
  id: string;
  developer: string;
  title: string;
  metaText: string; // "N bed · Area"
  priceText: string | null;
  href: string | null;
  image: string | null;
}

function parseCards(html: string): ParsedCard[] {
  const $ = cheerio.load(html);
  const cards: ParsedCard[] = [];

  $(CARD_SELECTOR).each((_, el) => {
    const $card = $(el);
    const href = $card.attr("href") ?? null;
    const id = href?.match(/\/property\/(\d+)/)?.[1] ?? null;
    const developer = $card.find(".dev_card_developer").first().text().trim();
    const title = $card.find(".dev_card_title").first().text().trim();
    const metaText = $card.find(".dev_card_meta").first().text().replace(/\s+/g, " ").trim();
    const priceText = $card.find(".dev_card_price").first().text().replace(/\s+/g, " ").trim() || null;
    const bgStyle = $card.find(".dev_card_img").first().attr("style") ?? "";
    const imgMatch = bgStyle.match(/url\(([^)]+)\)/);

    if (!id || !title || !href) return; // no real id/name/link — nothing to build a listing from
    cards.push({ id, developer, title, metaText, priceText, href, image: imgMatch ? imgMatch[1] : null });
  });

  return cards;
}

function pageUrl(pageNum: number): string {
  return pageNum === 1 ? TARGET_URL : `${TARGET_URL}&page=${pageNum}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A single, unambiguous bedroom count from the card's own "N bed · Area"
 * text — e.g. "1 bed · Poplar" -> 1. Null for a range ("1-3 bed") or
 * anything else that doesn't parse to one clear number — never guessed. */
function singleBedroomCount(metaText: string): number | null {
  const m = metaText.match(/^(\d+)\s*bed\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function areaFromMetaText(metaText: string): string {
  const parts = metaText.split("·").map((p) => p.trim());
  return parts.length > 1 ? parts.slice(1).join(", ") : "";
}

function parsePriceValue(priceText: string | null): number | null {
  const match = priceText?.match(/£\s?[\d,]+/);
  if (!match) return null;
  const value = parseFloat(match[0].replace(/[£,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** One extra real request per listing (see file header) — plain fetch
 * through the same Playwright session, just to read the real postcode out
 * of the detail page's own `<meta name="description">` tag. Best-effort: a
 * failed/odd detail page never drops the listing, it just leaves postcode
 * blank rather than guessed. */
async function fetchPostcode(page: import("playwright-core").Page, url: string): Promise<string> {
  try {
    const res = await page.request.get(url, { timeout: GOTO_TIMEOUT_MS });
    if (!res.ok()) return "";
    const html = await res.text();
    const descMatch = html.match(/<meta name="description" content="([^"]*)"/);
    if (!descMatch) return "";
    const postcodeMatch = descMatch[1].match(EMBEDDED_UK_POSTCODE_RE);
    return postcodeMatch ? postcodeMatch[0].toUpperCase() : "";
  } catch {
    return "";
  }
}

export const renownedHomesAdapter: SourceAdapter = {
  id: SOURCE_ID, // must match the id in london-developers.json exactly
  name: "Renowned Homes",

  async run(): Promise<AdapterRunResult> {
    // Own browser instance for this one call, always closed after — see
    // lib/adapters/browser.ts's own doc comment for why this replaced a
    // shared, never-closed singleton.
    return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });

    try {
      const page = await context.newPage();

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Renowned Homes search page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Renowned Homes search page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      console.warn("[renowned-homes] no network-json listings feed found (Next.js RSC prefetch traffic only) — using server-rendered HTML cards");

      // CRITICAL: past the real last page, this site does NOT return 0
      // cards — it just re-serves the final page's own content forever
      // (confirmed live: page 14 and page 15 return byte-identical card
      // ids to whatever the true last page is). So "0 cards" alone can
      // never be trusted to mean "reached the end" here. The real page
      // count is read from page 1's own numbered pager links instead
      // (`?price_max=450000&page=N`, confirmed live: highest N shown is the
      // real last page) and used as the primary stopping point, with an
      // all-cards-already-seen check as a second, independent safety net
      // in case that pager reading is ever wrong.
      const pagerNumbers = [...initialHtml.matchAll(/[?&](?:amp;)?page=(\d+)/g)].map((m) => parseInt(m[1], 10));
      const declaredLastPage = pagerNumbers.length > 0 ? Math.max(...pagerNumbers) : null;
      const pageCap = declaredLastPage ? Math.min(MAX_PAGES, declaredLastPage) : MAX_PAGES;
      console.warn(`[renowned-homes] page 1's own pager reports ${declaredLastPage ?? "an unknown"} page(s) total`);

      const allCards: ParsedCard[] = parseCards(initialHtml);
      const seenIdsSoFar = new Set(allCards.map((c) => c.id));
      let pagesVisited = 1;

      for (let pageNum = 2; pageNum <= pageCap; pageNum++) {
        await delay(PAGE_FETCH_DELAY_MS);
        let pageHtml: string;
        try {
          const res = await page.request.get(pageUrl(pageNum), { timeout: GOTO_TIMEOUT_MS });
          if (!res.ok()) {
            console.warn(`[renowned-homes] page ${pageNum}: HTTP ${res.status()} — stopping`);
            break;
          }
          pageHtml = await res.text();
        } catch (err) {
          console.warn(`[renowned-homes] page ${pageNum}: fetch failed (${err instanceof Error ? err.message : String(err)}) — stopping`);
          break;
        }

        const pageCards = parseCards(pageHtml);
        if (pageCards.length === 0) {
          console.warn(`[renowned-homes] page ${pageNum}: 0 cards — reached the end`);
          break;
        }
        const anyNew = pageCards.some((c) => !seenIdsSoFar.has(c.id));
        if (!anyNew) {
          console.warn(`[renowned-homes] page ${pageNum}: every card already seen on an earlier page — reached the real end, stopping`);
          break;
        }
        for (const c of pageCards) seenIdsSoFar.add(c.id);
        allCards.push(...pageCards);
        pagesVisited = pageNum;
      }
      if (pagesVisited >= MAX_PAGES) {
        console.warn(`[renowned-homes] hit the ${MAX_PAGES}-page safety cap`);
      }
      console.warn(`[renowned-homes] walked ${pagesVisited} page(s), ${allCards.length} card(s) collected in total`);

      const listings: AdapterListing[] = [];
      let skipped = 0;
      let skippedNonLondon = 0;
      const seenIds = new Set<string>();

      for (const card of allCards) {
        if (seenIds.has(card.id)) continue; // same development can recur across a page boundary
        seenIds.add(card.id);

        const priceValue = parsePriceValue(card.priceText);
        if (priceValue == null || !card.href) {
          skipped++;
          continue; // no honest price/url — never invent one
        }

        const url = new URL(card.href, BASE_URL).toString();
        await delay(DETAIL_FETCH_DELAY_MS);
        const postcode = await fetchPostcode(page, url);
        const area = areaFromMetaText(card.metaText);

        // CRITICAL — London only: this source's own URL (price_max=450000)
        // is a UK-wide filter, not a London one at all (confirmed live —
        // the page's own <title> is "Homes for Sale in the UK", and real
        // results include Maidenhead, Slough, Brentwood — none of them
        // London or even Greater London). Kept only when the real fetched
        // postcode is in a London area, or "London" appears in the
        // card's own name/area text — same backstop every other
        // aggregator-style adapter in this app applies (see
        // lib/adapters/londonPostcodes.ts).
        const isLondon = postcodeAreaIsLondon(postcode) || /\blondon\b/i.test(`${card.title} ${area}`);
        if (!isLondon) {
          skippedNonLondon++;
          continue;
        }

        listings.push({
          externalId: `renowned-homes-${card.id}`,
          title: card.title,
          price: card.priceText ?? `£${priceValue.toLocaleString("en-GB")}`,
          priceValue,
          priceRange: null, // one lead "From £X" figure per development — never invented
          url,
          images: card.image ? [card.image] : [],
          mainImage: card.image,
          bedrooms: singleBedroomCount(card.metaText),
          bedroomType: null, // not published per room
          tenure: detectTenure(`${card.title} ${card.metaText} ${card.developer}`),
          isNewBuild: true, // trustAsNewBuild — see file header
          postcode,
          area,
        });
      }

      console.warn(
        `[renowned-homes] trustAsNewBuild: ${listings.length} kept, ${skipped} skipped for missing price/url, ` +
          `${skippedNonLondon} not in a London postcode/area`
      );

      if (allCards.length === 0) {
        throw new Error(
          `Renowned Homes search page (${TARGET_URL}) returned HTTP ${httpStatus} and walked ${pagesVisited} ` +
            `page(s), but collected 0 cards at all — the page's HTML structure may have changed.`
        );
      }

      return { httpStatus, listings, extractionMethod: "html-pagination" };
    } finally {
      await context.close();
    }
    });
  },
};
