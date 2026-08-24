/**
 * Dedicated adapter for Benhams (benhams.com, "Benham & Reeves") — a real
 * third-party London (and a little Home Counties) new-homes aggregator, NOT
 * a developer's own site (source_type: "aggregator" in
 * london-developers.json) — no mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery, unlike the
 * generic auto-adapter — see createAutoAdapter in autoAdapter.ts):
 *
 *   https://www.benhams.com/new-homes/
 *
 * robots.txt (https://www.benhams.com/robots.txt) was checked first: none
 * of its Disallow rules (`/v5/`, `/payments/`, `/propco/`, etc.) match
 * `/new-homes/` or its own pagination endpoint below.
 *
 * Confirmed live (2026-08) by capturing this page's own network traffic: no
 * JSON API — plain server-rendered HTML (`#for-sale-card-data .card`
 * cards). The page states "284 New build developments available" but
 * server-renders only 32 initially.
 *
 * CRITICAL requirement — "Load more": a real `<button id="load-more-for-
 * sale" data-page="2">` — clicking it fires a real, public,
 * unauthenticated GET to `/new-homes?search=&min=&bed=&development_type=
 * &page=N&currentUrl=%2Fnew-homes%2F&include_sold=` and appends 32 more
 * cards to the same container (confirmed live: 32 → 64 → 96 cards across
 * two clicks, `data-page` incrementing each time). Driven by actually
 * clicking the real button and waiting for the card count to grow, capped
 * at 20 clicks (comfortably above the ~9 needed for 284 results) — stops
 * early once a click adds no new cards or the button is no longer visible.
 *
 * Each card's own title text ends in the development's real postcode
 * district (e.g. "King George's Gate, Earlsfield, SW18") — confirmed live
 * across every card checked — extracted directly rather than needing a
 * separate fetch per listing. `isLondonHome()` filters using the same
 * postcode-area logic as the other dedicated adapters
 * (lib/adapters/londonPostcodes.ts) — confirmed live: this aggregator also
 * lists Home Counties towns (e.g. Watford, WD24) alongside London.
 *
 * `bedrooms` is only ever filled in when the card's own description states
 * a single, unambiguous count — most cards describe a development ("1, 2 &
 * 3 bedroom apartments"), not one specific home, so this is usually null,
 * same "never guess which one" rule Peabody/1newhomes use
 * (lib/adapters/peabodyNewHomes.ts, lib/adapters/oneNewHomes.ts). Tenure:
 * `detectTenure()` runs over the description text.
 *
 * CRITICAL dedupe rule: being a third-party aggregator, this adapter's
 * output is deduped against every current direct-developer listing before
 * being stored — see lib/adapters/dedupe.ts and lib/syncEngine.ts.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { postcodeAreaIsLondon, UK_OUTWARD_CODE_RE } from "./londonPostcodes";
import { detectTenure } from "./tenureDetection";
import { detectIsNewBuild } from "./newBuildDetection";
import { withBrowser } from "./browser";

const TARGET_URL = "https://www.benhams.com/new-homes/";
const BASE_URL = "https://www.benhams.com";
const GOTO_TIMEOUT_MS = 60_000;
const CARD_SELECTOR = "#for-sale-card-data .card";
const LOAD_MORE_SELECTOR = "#load-more-for-sale";
const MAX_LOAD_MORE_CLICKS = 20;

interface ParsedCard {
  titleText: string;
  description: string;
  priceText: string | null;
  href: string | null;
  image: string | null;
}

function parseCards(html: string): ParsedCard[] {
  const $ = cheerio.load(html);
  const cards: ParsedCard[] = [];

  $(CARD_SELECTOR).each((_, el) => {
    const $card = $(el);
    const titleText = $card.find(".card-title a").first().text().replace(/\s+/g, " ").trim();
    const description = $card.find(".card-text").first().text().replace(/\s+/g, " ").trim();
    const priceBlock = $card.find(".font-18.fontweight-600").first().text().replace(/\s+/g, " ").trim();
    const priceText = priceBlock.includes("£") ? priceBlock : null;
    const href = $card.find(".card-title a").first().attr("href") ?? null;
    const image = $card.find(".card-img img").first().attr("src") ?? null;

    if (!titleText || !href) return; // no real name/link — nothing to build a listing from
    cards.push({ titleText, description, priceText, href, image });
  });

  return cards;
}

/** Postcode is the trailing comma-separated segment of the card's own
 * title text (e.g. "King George's Gate, Earlsfield, SW18") — the outward
 * code only (Benhams never publishes the inward part on this list page).
 * `area` is whatever's left after stripping it. */
function locationFromTitle(titleText: string): { name: string; area: string; postcode: string } {
  const parts = titleText.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { name: titleText, area: "", postcode: "" };
  const last = parts[parts.length - 1];
  if (UK_OUTWARD_CODE_RE.test(last)) {
    return {
      name: parts[0],
      area: parts.slice(1, -1).join(", "),
      postcode: last.toUpperCase(),
    };
  }
  return { name: parts[0], area: parts.slice(1).join(", "), postcode: "" };
}

function isLondonHome(postcode: string, titleText: string): boolean {
  if (postcode && postcodeAreaIsLondon(postcode)) return true;
  return /\blondon\b/i.test(titleText);
}

/** A single, unambiguous bedroom count from the card's own description —
 * e.g. "a 2 bedroom apartment" -> 2. Returns null when the description
 * mentions several distinct sizes (the common case, describing a whole
 * development) — never guessed, same rule as the other aggregator
 * adapters. */
function singleBedroomCount(description: string): number | null {
  const matches = [...description.matchAll(/(\d+)\s*-?\s*bed(?:room)?s?\b/gi)].map((m) => parseInt(m[1], 10));
  const distinct = new Set(matches);
  return distinct.size === 1 ? [...distinct][0] : null;
}

const PRICE_FIGURE_RE = /£\s?[\d,]+/;

function parsePriceValue(priceText: string | null): number | null {
  const match = priceText?.match(PRICE_FIGURE_RE);
  if (!match) return null;
  const value = parseFloat(match[0].replace(/[£,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const benhamsAdapter: SourceAdapter = {
  id: "benhams", // must match the id in london-developers.json exactly
  name: "Benhams",

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
          "Benhams new-homes page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Benhams new-homes page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      let resultsAppeared = true;
      try {
        await page.waitForSelector(`${CARD_SELECTOR}, text=/£\\s?\\d/`, { timeout: 30_000 });
      } catch {
        resultsAppeared = false;
        console.warn("[benhams] no result card / £-price appeared within 30000ms");
      }

      // CRITICAL: click "Load more" until it's gone or stops adding cards.
      let clicks = 0;
      let lastCardCount = await page.locator(CARD_SELECTOR).count().catch(() => 0);
      for (; clicks < MAX_LOAD_MORE_CLICKS; ) {
        const loadMore = page.locator(LOAD_MORE_SELECTOR).first();
        const visible = await loadMore.isVisible().catch(() => false);
        if (!visible) break;

        await loadMore.click().catch(() => {});
        clicks++;
        await page.waitForTimeout(900);

        const newCardCount = await page.locator(CARD_SELECTOR).count().catch(() => lastCardCount);
        if (newCardCount <= lastCardCount) {
          console.warn(
            `[benhams] "Load more" click ${clicks} added no new cards (${lastCardCount} → ${newCardCount}) — stopping`
          );
          break;
        }
        lastCardCount = newCardCount;
      }
      if (clicks >= MAX_LOAD_MORE_CLICKS) {
        console.warn(`[benhams] hit the ${MAX_LOAD_MORE_CLICKS}-click safety cap on "Load more"`);
      }

      await page.waitForTimeout(500);
      const renderedHtml = await page.content();
      const finalCardCount = await page.locator(CARD_SELECTOR).count().catch(() => lastCardCount);

      console.warn(
        `[benhams] ${requestLog.length} xhr/fetch request(s); "Load more" clicked ${clicks} time(s), ` +
          `${finalCardCount} result card(s) in the DOM afterwards`
      );

      const cards = parseCards(renderedHtml);
      const listings: AdapterListing[] = [];
      let skippedNoPrice = 0;
      let skippedNonLondon = 0;
      const seenUrls = new Set<string>();

      for (const card of cards) {
        const url = new URL(card.href!, BASE_URL).toString();
        if (seenUrls.has(url)) continue; // same card can appear twice across a re-sorted page boundary
        seenUrls.add(url);

        const { name, area, postcode } = locationFromTitle(card.titleText);
        if (!isLondonHome(postcode, card.titleText)) {
          skippedNonLondon++;
          continue;
        }

        const priceValue = parsePriceValue(card.priceText);
        if (priceValue == null) {
          skippedNoPrice++;
          console.warn(`[benhams] skipping "${name}" — no published price`);
          continue;
        }

        listings.push({
          externalId: `benhams-${url.replace(BASE_URL, "").replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-")}`,
          title: name,
          price: card.priceText ?? `£${priceValue.toLocaleString("en-GB")}`,
          priceValue,
          priceRange: null,
          url,
          images: card.image ? [card.image] : [],
          mainImage: card.image,
          bedrooms: singleBedroomCount(card.description),
          bedroomType: null, // not published per room
          tenure: detectTenure(card.description),
          // "New homes" aggregator by its own stated scope (see file
          // header) — detectIsNewBuild still genuinely checks the card's
          // own name + description for a resale signal first.
          isNewBuild: detectIsNewBuild(`${name} ${card.description}`).isNewBuild,
          postcode,
          area,
        });
      }

      if (listings.length === 0) {
        throw new Error(
          `Benhams new-homes page (${TARGET_URL}) returned HTTP ${httpStatus}` +
            (resultsAppeared ? "" : " and no result card/price ever appeared") +
            `. "Load more" was clicked ${clicks} time(s) (${finalCardCount} card(s) in the DOM). Parsed ` +
            `${cards.length} card(s) total (${skippedNonLondon} not in a London postcode, ${skippedNoPrice} ` +
            `with no published price), but 0 produced a usable London listing.`
        );
      }

      console.warn(
        `[benhams] built ${listings.length} London listing(s) via html-pagination ` +
          `(${skippedNonLondon} non-London card(s) skipped, ${skippedNoPrice} unpriced card(s) skipped)`
      );

      return { httpStatus, listings, extractionMethod: "html-pagination" };
    } finally {
      await context.close();
    }
    });
  },
};
