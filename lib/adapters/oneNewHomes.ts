/**
 * Dedicated adapter for 1newhomes (1newhomes.com) — a real third-party
 * London new-homes aggregator, NOT a developer's own site
 * (source_type: "aggregator" in london-developers.json) — no mock/sample
 * data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery, unlike the
 * generic auto-adapter — see createAutoAdapter in autoAdapter.ts):
 *
 *   https://1newhomes.com/new-homes/
 *
 * robots.txt (https://1newhomes.com/robots.txt) was checked first:
 * `Disallow: /new-homes/*?` blocks query-string variants of this path —
 * this adapter never uses one. Pagination (below) is entirely path-based.
 *
 * Confirmed live (2026-08) by capturing this page's own network traffic: no
 * JSON API — this is plain server-rendered HTML
 * (`.sentence-v3-catalog` cards). The page states "We compile details on
 * 1,570 new build developments across London" but server-renders only 20
 * per page.
 *
 * CRITICAL requirement — pagination: real, path-based, confirmed live —
 * `/new-homes/`, `/new-homes/page-2`, `/new-homes/page-3`, ... (no query
 * string at all, so robots.txt's disallow above doesn't apply). Walked by
 * fetching each page directly through the same Playwright session
 * (`page.request.get`) rather than a full re-navigation per page — this is
 * plain server-rendered HTML, not something that needs re-rendering ~79
 * times — until a page returns zero cards or the safety cap is hit.
 *
 * Postcode is never published on these list cards (checked directly — only
 * a nearby-station name, e.g. "Canada Water") — left blank rather than
 * guessed. London-filtering instead relies on this being the site's own
 * base London catalog by construction: its own "By Area" links are all
 * London sub-regions (Central/East/North/North West/South/South East/South
 * West/West London), and developments the site itself considers merely
 * "near London" live under a distinct path (`/new-homes/around-london/`)
 * that this adapter never visits — confirmed live, not assumed. A
 * secondary text check (`/\blondon\b/i` against the card's own area/intro
 * text, or a real London postcode area if one ever is stated) still runs
 * per listing as a defensive backstop, same postcode-area logic as the
 * other dedicated adapters (lib/adapters/londonPostcodes.ts).
 *
 * `bedrooms` is only ever filled in when a card states a single,
 * unambiguous count (e.g. "3 beds") — a card listing several sizes (e.g.
 * "Studio • 1 • 2 • 3 beds", the common case here) has no way to honestly
 * attribute one specific count to the card's single "from" price, so it's
 * left null rather than guessed — same rule Peabody's adapter uses for the
 * same reason (lib/adapters/peabodyNewHomes.ts).
 *
 * Tenure: `detectTenure()` runs over the card's own tag/intro text — this
 * being a general London aggregator (not a shared-ownership specialist),
 * most cards genuinely state nothing about tenure and this comes back
 * null, never guessed.
 *
 * CRITICAL dedupe rule: being a third-party aggregator, this adapter's
 * output is deduped against every current direct-developer listing before
 * being stored — see lib/adapters/dedupe.ts and lib/syncEngine.ts. A
 * direct developer's own site always wins; this adapter only ever
 * contributes listings not already covered by one.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectTenure } from "./tenureDetection";
import { getSharedBrowser } from "./browser";

const TARGET_URL = "https://1newhomes.com/new-homes/";
const BASE_URL = "https://1newhomes.com";
const GOTO_TIMEOUT_MS = 60_000;
const CARD_SELECTOR = ".sentence-v3-catalog";
const MAX_PAGES = 100; // real total confirmed live: ~79 pages (1,570 @ 20/page) — capped well above that
const PAGE_FETCH_DELAY_MS = 300; // be a polite crawler across ~79 page fetches

function pageUrl(pageNum: number): string {
  return pageNum === 1 ? TARGET_URL : `${BASE_URL}/new-homes/page-${pageNum}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedCard {
  id: string;
  name: string;
  builder: string;
  area: string;
  bedsText: string;
  intro: string;
  priceText: string | null;
  href: string | null;
  image: string | null;
}

function parseCards(html: string): ParsedCard[] {
  const $ = cheerio.load(html);
  const cards: ParsedCard[] = [];

  $(CARD_SELECTOR).each((_, el) => {
    const $card = $(el);
    const id = $card.attr("data-id") ?? "";
    const name = $card.attr("data-title")?.trim() || $card.find(".building-name").first().text().trim();
    const builder = $card.attr("data-builder")?.trim() ?? "";
    const area = $card.find(".station").first().text().trim();
    const bedsText = $card.find(".tags .tag").first().text().trim();
    const intro = $card.find(".intro").first().text().replace(/\s+/g, " ").trim();
    const priceText = $card.find(".sentence-v3-catalog__price .value").first().text().trim() || null;
    const href = $card.find("a.building-name").first().attr("href") ?? $card.find("a.sentence-v3-catalog__img").first().attr("href") ?? null;
    const imgRel = $card.find("a.sentence-v3-catalog__img img").first().attr("src") ?? null;

    if (!id || !name) return; // no real id/name — nothing to build a listing from
    cards.push({
      id,
      name,
      builder,
      area,
      bedsText,
      intro,
      priceText,
      href,
      image: imgRel ? new URL(imgRel, BASE_URL).toString() : null,
    });
  });

  return cards;
}

/** A single, unambiguous bedroom count from the card's own beds text — e.g.
 * "3 beds" -> 3. Returns null when several distinct sizes are listed (e.g.
 * "Studio • 1 • 2 • 3 beds", the common case here) — never guessed. */
function singleBedroomCount(bedsText: string): number | null {
  const hasStudio = /\bstudio\b/i.test(bedsText);
  const numbers = [...bedsText.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10));
  const distinct = new Set(numbers);
  if (hasStudio) distinct.add(0);
  return distinct.size === 1 ? [...distinct][0] : null;
}

export const oneNewHomesAdapter: SourceAdapter = {
  id: "1newhomes", // must match the id in london-developers.json exactly
  name: "1newhomes",

  async run(): Promise<AdapterRunResult> {
    const browser = await getSharedBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });

    try {
      const page = await context.newPage();

      const requestLog: { method: string; url: string }[] = [];
      page.on("request", (req) => {
        if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
          requestLog.push({ method: req.method(), url: req.url() });
        }
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "1newhomes catalog page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`1newhomes catalog page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      console.warn(
        `[1newhomes] ${requestLog.length} xhr/fetch request(s) on initial load; no JSON listings feed found ` +
          `(server-rendered HTML pagination instead — see file header)`
      );
      for (const r of requestLog) console.warn(`[1newhomes]   ${r.method} ${r.url}`);

      // CRITICAL: walk every page (path-based, confirmed live — see file
      // header) until one returns zero cards or the safety cap is hit.
      const allCards: ParsedCard[] = parseCards(initialHtml);
      let pagesVisited = 1;

      for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
        await delay(PAGE_FETCH_DELAY_MS);
        let pageHtml: string;
        try {
          const res = await page.request.get(pageUrl(pageNum));
          if (!res.ok()) {
            console.warn(`[1newhomes] page ${pageNum}: HTTP ${res.status()} — stopping`);
            break;
          }
          pageHtml = await res.text();
        } catch (err) {
          console.warn(`[1newhomes] page ${pageNum}: fetch failed (${err instanceof Error ? err.message : String(err)}) — stopping`);
          break;
        }

        const pageCards = parseCards(pageHtml);
        if (pageCards.length === 0) {
          console.warn(`[1newhomes] page ${pageNum} had 0 cards — reached the end`);
          break;
        }
        allCards.push(...pageCards);
        pagesVisited = pageNum;
      }
      if (pagesVisited >= MAX_PAGES) {
        console.warn(`[1newhomes] hit the ${MAX_PAGES}-page safety cap`);
      }

      console.warn(`[1newhomes] visited ${pagesVisited} page(s), ${allCards.length} card(s) collected in total`);

      const listings: AdapterListing[] = [];
      let skippedNoPrice = 0;
      let skippedNonLondon = 0;
      const seenIds = new Set<string>();

      for (const card of allCards) {
        if (seenIds.has(card.id)) continue; // same development can recur across a re-sorted page boundary
        seenIds.add(card.id);

        const haystack = `${card.name} ${card.area} ${card.intro}`;
        const isLondon = /\blondon\b/i.test(haystack) || card.href?.includes("-london");
        if (!isLondon) {
          skippedNonLondon++;
          continue;
        }

        const priceValue = card.priceText ? parseFloat(card.priceText.replace(/[£,\s]/g, "")) : NaN;
        if (!Number.isFinite(priceValue) || priceValue <= 0) {
          skippedNoPrice++;
          continue; // no honest price published (often literally "Price on request") — never invent one
        }
        if (!card.href) continue; // no real listing URL — never invent one

        const url = new URL(card.href, BASE_URL).toString();

        listings.push({
          externalId: `1newhomes-${card.id}`,
          title: card.name,
          price: `From £${priceValue.toLocaleString("en-GB")}`,
          priceValue,
          priceRange: null,
          url,
          images: card.image ? [card.image] : [],
          mainImage: card.image,
          bedrooms: singleBedroomCount(card.bedsText),
          bedroomType: null, // not published per room
          tenure: detectTenure(`${card.bedsText} ${card.intro}`),
          isNewBuild: true,
          postcode: "", // never published on this list page — see file header
          area: card.area,
        });
      }

      if (listings.length === 0) {
        throw new Error(
          `1newhomes catalog (${TARGET_URL}) walked ${pagesVisited} page(s), collected ${allCards.length} card(s) ` +
            `(${skippedNonLondon} not recognisably London, ${skippedNoPrice} with no published price), but 0 ` +
            `produced a usable listing.`
        );
      }

      console.warn(
        `[1newhomes] built ${listings.length} listing(s) via html-pagination ` +
          `(${skippedNonLondon} non-London card(s) skipped, ${skippedNoPrice} unpriced card(s) skipped)`
      );

      return { httpStatus, listings, extractionMethod: "html-pagination" };
    } finally {
      await context.close();
    }
  },
};
