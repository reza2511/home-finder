/**
 * Dedicated adapter for Benhams' London new-build hub (benhams.com/london/)
 * — a DIFFERENT page from the existing Benhams aggregator adapter
 * (lib/adapters/benhams.ts, id "benhams", https://www.benhams.com/new-homes/)
 * — a general London new-build estate agent/aggregator, NOT a developer's
 * own site (source_type: "estate-agent" in london-developers.json,
 * trustAsNewBuild: true — see file footer). No mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery), and the
 * existing `benhams` (/new-homes/) source is left completely as-is —
 * this is a second, separate registry entry (id "benhams-london"), not a
 * replacement or duplicate of it:
 *
 *   https://www.benhams.com/london/
 *
 * robots.txt (https://www.benhams.com/robots.txt, checked 2026-08 — same
 * file the existing benhams.ts already documents): none of its Disallow
 * rules (`/v5/`, `/payments/`, `/propco/`, etc.) match `/london/` or its
 * own campaign-listing API below.
 *
 * CRITICAL — this page's own structure is NOT the same as /new-homes/'s:
 * confirmed live, it's a "campaign" hub — each card (`.develop-listing`)
 * represents one whole marketing campaign for a development (sometimes
 * several developments at once, e.g. "The London Square Collection"), not
 * an individual priced home, and — confirmed live, checked directly — NO
 * price appears anywhere on the list page itself (0 "£" occurrences across
 * all 96 cards' markup). A real price sometimes appears on each campaign's
 * own detail page instead — but not reliably in one place: confirmed live
 * across several real campaigns, it can be in the `<meta name=
 * "description">` tag ("...starting from £450,000 at Royal Arsenal
 * Riverside..."), in the visible body text with different phrasing ("low
 * entry price of £509,000"), in bedroom-specific body text with no meta
 * mention at all ("1 bed 1 bath from £419,000, 2 bed 2 bath from
 * £539,000"), or genuinely absent from the entire page (real campaigns
 * exist with zero £ mentions anywhere — a pure marketing/enquiry page with
 * no published price at all). So every campaign card needs one extra real
 * per-listing detail-page fetch, scanning the WHOLE page's text for every
 * "from £X"-shaped figure and using the lowest one found as this
 * development's lead price — same "one row per development, its own lead
 * price" limitation this app's Countryside and Renowned Homes adapters
 * already document, for the same underlying reason (that's genuinely what
 * the source publishes, when it publishes anything at all). A campaign
 * with no price found anywhere is honestly skipped, never invented.
 * Bedrooms are never published as a single per-development count on either
 * page (only ever per-unit-type within body text, as above) — left null,
 * never guessed.
 *
 * CRITICAL — network-json feed check: confirmed live by capturing this
 * page's own network traffic while clicking its real "Load more" control —
 * it DOES fire a real JSON endpoint,
 * `POST https://www.benhams.com/api/v1/campaign/listing/`, returning
 * `{ type, totalPages, count, curpage, nextPage, data }` where `data` is a
 * raw HTML fragment of the next batch of cards (JSON-wrapped HTML, not
 * fully structured fields). Calling it standalone needs a `br-token`
 * request header the page's own JS generates per-load — rather than
 * reverse-engineering that token, this adapter drives it the same, proven
 * way the existing benhams.ts adapter already does: by actually clicking
 * the real "Load more" button and waiting for the card count to grow
 * (`a.loadmore-campaigns`, confirmed live: 16 → 32 → ... cards per click,
 * `data-totalpage="6"` at time of writing). extractionMethod: "network-json"
 * since the underlying response genuinely is JSON, even though it's driven
 * by a click rather than a direct URL walk.
 *
 * Each card's own title text ends in the development's real postcode
 * district (e.g. "Royal Arsenal Riverside, Woolwich SE18") — same
 * convention as the existing benhams.ts adapter, confirmed live here too —
 * extracted directly rather than needing a separate fetch. `isLondonHome()`
 * reuses the same postcode-area logic (lib/adapters/londonPostcodes.ts).
 *
 * Tenure: `detectTenure()` runs over the card's own description plus the
 * detail page's own meta description text — genuinely rare to state
 * tenure here (checked live), comes back null most of the time, never
 * guessed.
 *
 * trustAsNewBuild: true (this entry) — every campaign collected here is
 * kept and stored as `isNewBuild: true`, no per-listing new-build
 * signal-checking — this hub is Benhams' own dedicated new-build London
 * page by construction ("New-build developments for sale in London").
 *
 * CRITICAL — dedupe: explicitly expected to overlap heavily with BOTH the
 * existing `benhams` (/new-homes/) source AND direct developers (both
 * pages are the same agency's own catalog, just reached via different
 * navigation) — being a non-direct source, this adapter's output is
 * deduped against every other currently-active listing before being
 * stored — see lib/adapters/dedupe.ts and lib/syncEngine.ts's
 * isSecondPhaseSource / sequential second-phase ordering. This source is
 * registered AFTER the existing `benhams` entry (see
 * london-developers.json / lib/adapters/index.ts), so on a genuine overlap
 * the already-established `benhams` (/new-homes/) listing wins and this
 * one is dropped — not the other way around.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { postcodeAreaIsLondon, UK_OUTWARD_CODE_RE } from "./londonPostcodes";
import { detectTenure } from "./tenureDetection";
import { getSharedBrowser } from "./browser";

const SOURCE_ID = "benhams-london";
const TARGET_URL = "https://www.benhams.com/london/";
const BASE_URL = "https://www.benhams.com";
const GOTO_TIMEOUT_MS = 60_000;
const CARD_SELECTOR = ".develop-listing";
const LOAD_MORE_SELECTOR = "a.loadmore-campaigns";
const MAX_LOAD_MORE_CLICKS = 20; // real total confirmed live: ~5 clicks needed (data-totalpage 6)
const DETAIL_FETCH_DELAY_MS = 250; // be a polite crawler across dozens of per-listing detail fetches

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedCard {
  campaignId: string;
  titleText: string;
  description: string;
  href: string | null;
  image: string | null;
}

function parseCards(html: string): ParsedCard[] {
  const $ = cheerio.load(html);
  const cards: ParsedCard[] = [];

  $(CARD_SELECTOR).each((_, el) => {
    const $card = $(el);
    const titleLink = $card.find(".develop-listing-dtl h4 a").first();
    const titleText = titleLink.text().replace(/\s+/g, " ").trim();
    const href = titleLink.attr("href") ?? null;
    const description = $card.find(".para-fixed").first().text().replace(/\s+/g, " ").trim();
    const image = $card.find(".develop-listing-img img").first().attr("data-src")
      ?? $card.find(".develop-listing-img img").first().attr("src")
      ?? null;
    const campaignId = $card.find("button[data-campaign_id]").first().attr("data-campaign_id") ?? href ?? "";

    if (!titleText || !href) return; // no real name/link — nothing to build a listing from
    cards.push({ campaignId, titleText, description, href, image });
  });

  return cards;
}

/** Postcode is the trailing comma-separated segment of the card's own
 * title text (e.g. "Royal Arsenal Riverside, Woolwich SE18") — same
 * convention as lib/adapters/benhams.ts, confirmed live on this page too. */
function locationFromTitle(titleText: string): { name: string; area: string; postcode: string } {
  const parts = titleText.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { name: titleText, area: "", postcode: "" };
  const last = parts[parts.length - 1];
  if (UK_OUTWARD_CODE_RE.test(last)) {
    return { name: parts[0], area: parts.slice(1, -1).join(", "), postcode: last.toUpperCase() };
  }
  return { name: parts[0], area: parts.slice(1).join(", "), postcode: "" };
}

function isLondonHome(postcode: string, titleText: string): boolean {
  if (postcode && postcodeAreaIsLondon(postcode)) return true;
  return /\blondon\b/i.test(titleText);
}

// Deliberately broad — confirmed live across real campaign pages, a price
// (when stated at all) shows up in several different phrasings and isn't
// reliably confined to the meta description: "1 bed 1 bath from £419,000"
// (in the visible body text, bedroom-specific, no meta mention at all),
// "starting from £450,000" (meta description), "low entry price of
// £509,000" (meta description, no "from" at all). All three real examples
// are covered here; every match found across the WHOLE page is collected
// and the lowest figure is used as this development's lead "from" price —
// the same "starting price for the cheapest unit" convention every other
// adapter in this app uses for a one-row-per-development source.
const PRICE_FROM_RE = /(?:from|starting\s+(?:from|at)|entry\s+price\s+of)\s*£\s?([\d,]+)/gi;

// A real live miss otherwise: scanning the whole page catches genuine sale
// prices in unexpected places (see PRICE_FROM_RE's own comment), but also
// picks up unrelated small figures on the same page with the same "from
// £X" shape — a monthly rent quote, a service charge, a deposit — that are
// real numbers on the page but not a genuine sale price for this
// development. No real London sale listing in this app has ever priced
// below this floor; anything under it is treated as noise, not a price.
const MIN_PLAUSIBLE_SALE_PRICE = 50_000;

interface DetailData {
  priceValue: number | null;
  priceText: string | null;
  description: string;
}

/** One extra real request per listing (see file header — this source
 * genuinely never states a price on the list page at all) — plain fetch
 * through the same Playwright session, scanning the WHOLE detail page's
 * text (not just its meta description — see PRICE_FROM_RE's own comment)
 * for the lowest "from £X"-shaped figure. Best-effort: a failed/odd detail
 * page, or one that genuinely never states a price anywhere (confirmed
 * live: real campaigns exist with zero £ mentions on the whole page),
 * just leaves price null, so the listing is skipped downstream rather than
 * ever inventing a figure. */
async function fetchDetail(page: import("playwright-core").Page, url: string): Promise<DetailData> {
  try {
    const res = await page.request.get(url, { timeout: GOTO_TIMEOUT_MS });
    if (!res.ok()) {
      console.warn(`[benhams-london] detail fetch for ${url} returned HTTP ${res.status()}`);
      return { priceValue: null, priceText: null, description: "" };
    }
    const html = await res.text();
    const descMatch = html.match(/<meta name="description" content="([^"]*)"/);
    const description = descMatch ? descMatch[1] : "";

    const bodyText = html.replace(/<[^>]+>/g, " ");
    const values = [...bodyText.matchAll(PRICE_FROM_RE)]
      .map((m) => parseFloat(m[1].replace(/,/g, "")))
      .filter((v) => Number.isFinite(v) && v >= MIN_PLAUSIBLE_SALE_PRICE);
    if (values.length === 0) return { priceValue: null, priceText: null, description };

    const value = Math.min(...values);
    return { priceValue: value, priceText: `From £${value.toLocaleString("en-GB")}`, description };
  } catch (err) {
    console.warn(`[benhams-london] detail fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return { priceValue: null, priceText: null, description: "" };
  }
}

export const benhamsLondonAdapter: SourceAdapter = {
  id: SOURCE_ID, // must match the id in london-developers.json exactly
  name: "Benhams London",

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

      let sawCampaignApiJson = false;
      page.on("response", (res) => {
        if (res.url().includes("/api/v1/campaign/listing/")) sawCampaignApiJson = true;
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Benhams London hub page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Benhams London hub page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      let resultsAppeared = true;
      try {
        await page.waitForSelector(CARD_SELECTOR, { timeout: 30_000 });
      } catch {
        resultsAppeared = false;
        console.warn("[benhams-london] no result card appeared within 30000ms");
      }

      // CRITICAL deep pagination: click "Load more" until it's gone or
      // stops adding cards — see file header for why this drives the real
      // network-json campaign-listing endpoint rather than calling it
      // directly.
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
          console.warn(`[benhams-london] "Load more" click ${clicks} added no new cards (${lastCardCount} → ${newCardCount}) — stopping`);
          break;
        }
        lastCardCount = newCardCount;
      }
      if (clicks >= MAX_LOAD_MORE_CLICKS) {
        console.warn(`[benhams-london] hit the ${MAX_LOAD_MORE_CLICKS}-click safety cap on "Load more"`);
      }

      await page.waitForTimeout(500);
      const renderedHtml = await page.content();
      const finalCardCount = await page.locator(CARD_SELECTOR).count().catch(() => lastCardCount);

      console.warn(
        `[benhams-london] network-json campaign-listing endpoint ${sawCampaignApiJson ? "found" : "NOT found"}; ` +
          `"Load more" clicked ${clicks} time(s), ${finalCardCount} result card(s) in the DOM afterwards`
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

        await delay(DETAIL_FETCH_DELAY_MS);
        const detail = await fetchDetail(page, url);
        if (detail.priceValue == null) {
          skippedNoPrice++;
          console.warn(`[benhams-london] skipping "${name}" — no published price on its own detail page`);
          continue;
        }

        listings.push({
          externalId: `benhams-london-${card.campaignId || url.replace(BASE_URL, "").replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-")}`,
          title: name,
          price: detail.priceText ?? `£${detail.priceValue.toLocaleString("en-GB")}`,
          priceValue: detail.priceValue,
          priceRange: null,
          url,
          images: card.image ? [card.image] : [],
          mainImage: card.image,
          bedrooms: null, // never published on this source — see file header
          bedroomType: null,
          tenure: detectTenure(`${card.description} ${detail.description}`),
          isNewBuild: true, // trustAsNewBuild — see file header
          postcode,
          area,
        });
      }

      console.warn(
        `[benhams-london] trustAsNewBuild: ${listings.length} kept, ${skippedNoPrice} skipped for no published ` +
          `price, ${skippedNonLondon} not in a London postcode, out of ${cards.length} card(s) collected`
      );

      if (cards.length === 0) {
        throw new Error(
          `Benhams London hub page (${TARGET_URL}) returned HTTP ${httpStatus}` +
            (resultsAppeared ? "" : " and no result card ever appeared") +
            `. "Load more" was clicked ${clicks} time(s) (${finalCardCount} card(s) in the DOM), but parsed 0 cards.`
        );
      }

      return { httpStatus, listings, extractionMethod: "network-json" };
    } finally {
      await context.close();
    }
  },
};
