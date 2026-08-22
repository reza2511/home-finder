/**
 * Dedicated adapter for Winkworth (winkworth.co.uk) — a general London
 * estate agent, NOT a new-build-only developer or aggregator
 * (source_type: "estate-agent" in london-developers.json). Added 2026-08
 * as a test of this app's resale-filtering approach. No mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery):
 *
 *   https://www.winkworth.co.uk/london/london/new-homes-for-sale?priceto=500000
 *
 * This is Winkworth's own dedicated new-homes section (distinct from the
 * general for-sale search this adapter used before 2026-08) — most of its
 * stock is already genuine new-build, confirmed live: with this exact
 * `priceto=500000` cap it's 14 results across 1 page; removing `priceto`
 * entirely gives 53 results across 3 pages (checked directly, not applied
 * here — the cap is exactly what was asked for; a decision on whether to
 * widen it belongs to whoever's using this adapter, not baked in here).
 *
 * trustAsNewBuild (london-developers.json, this entry): set true. The
 * text-based hasExplicitNewBuildSignal() safety net this adapter first
 * shipped with was found live to be actively wrong here — the section is
 * already curated as new-build by the site itself, but several genuine
 * off-plan listings (e.g. McCarthy Stone retirement apartments described
 * only as "by award-winning builder... will be decorated", never using any
 * of the checked phrases like "new build"/"off-plan"/"development") were
 * being wrongly discarded as resale. Per explicit instruction, this source
 * is now fully trusted instead: every card collected below is kept, no
 * per-listing new-build signal-checking at all — see trustsAsNewBuild() in
 * lib/developers.ts and its use below. hasExplicitNewBuildSignal() is kept
 * imported and importable (not deleted) since the flag is per-source and a
 * future non-trusted estate-agent source would still need it.
 *
 * robots.txt (https://www.winkworth.co.uk/robots.txt, checked 2026-08) has
 * two things relevant here:
 *   - A dedicated `User-agent: ClaudeBot` block with `Disallow: /` —
 *     Cloudflare-managed, blocking this crawler by name specifically. This
 *     is the same shape of conflict as ecoworld-london's (left unwired for
 *     exactly this reason) — here it was surfaced to the user via
 *     AskUserQuestion and the user explicitly chose "Proceed anyway" (an
 *     informed, deliberate override), which is why this adapter exists at
 *     all. `User-agent: *` gets a blanket `Allow: /` on everything used
 *     here.
 *   - `Disallow: /api/` (for every user-agent, including `*`) — this
 *     adapter never calls any `/api/*` path; it only ever navigates the
 *     public search-results HTML page itself (below), which the generic
 *     `Allow: /` covers.
 *
 * CRITICAL — extraction method: confirmed live by saving and inspecting the
 * raw HTML directly (not just a rendered DOM) that this search page
 * server-renders its own full page-of-results as a single JSON object in a
 * `data-dc-search-results-list="{...}"` attribute on the results-list
 * `<div>` — HTML-entity-escaped, present on first load with no XHR/client
 * hydration needed. This is a genuine network-json-equivalent feed reached
 * via one page load per page number, not HTML-heuristic card scraping and
 * not a click-driven "load more"/infinite-scroll — same feed shape as the
 * general for-sale page this adapter used before. Its own `pagination`
 * object (`pageCount`, `totalElements`, `currentPage`) is real and used
 * directly to know when every page has been walked.
 *
 * CRITICAL — pagination: the exact given URL is page 1; subsequent pages
 * are the same URL plus `&page=N` (confirmed live — the site 302-redirects
 * to reorder the query string, still resolves to the same page). Walked
 * sequentially via `page.request.get()` through the same Playwright session
 * (this is plain server-rendered HTML per page, not something that needs a
 * full re-render each time) until `pageCount` pages have been fetched or a
 * page returns 0 cards, with a safety cap well above any page count seen
 * live so far and page-count logging throughout.
 *
 * CRITICAL — new-build filter: bypassed for this source (trustAsNewBuild —
 * see above). Every card collected is kept and stored with
 * `isNewBuild: true`; no hasExplicitNewBuildSignal() check runs at all.
 *
 * Tenure: Winkworth publishes a clean structured `tenure` field per card
 * ("Freehold" / "Leasehold" / "Share of Freehold") — passed straight
 * through detectTenure() rather than guessed from free text. Shared
 * ownership (never seen in this structured field directly, but checked for
 * in the free text too, same as every other adapter) maps to
 * `shared_ownership` via the same detectTenure() call; the sync-engine-wide
 * applySharedOwnershipOverride is still a second line of defense on top.
 *
 * Bathrooms: the feed's own `bathrooms` field (a real per-listing integer,
 * confirmed live) is used directly — never derived from bedroom count.
 *
 * Postcode: `postcode` field is a real full postcode (e.g. "N4 1PZ"), used
 * directly — more precise than most of this app's other sources. `area`
 * uses the card's own `office.name` (a real human-readable local-office
 * name, e.g. "Stoke Newington") in preference to the 3-letter internal
 * `area` code, which is an office code, not a place name.
 *
 * CRITICAL — dedupe: being a non-direct source, this adapter's output is
 * deduped against every current direct-developer listing before being
 * stored — see lib/adapters/dedupe.ts and lib/syncEngine.ts's
 * isSecondPhaseSource. A direct developer's own site always wins.
 */
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectTenure } from "./tenureDetection";
import { hasExplicitNewBuildSignal } from "./newBuildDetection";
import { trustsAsNewBuild } from "../developers";
import { getSharedBrowser } from "./browser";

const SOURCE_ID = "winkworth";
const BASE_URL = "https://www.winkworth.co.uk";
const TARGET_URL = `${BASE_URL}/london/london/new-homes-for-sale?priceto=500000`;
const GOTO_TIMEOUT_MS = 60_000;
const RESULTS_LIST_ATTR = 'data-dc-search-results-list="';
// Real total confirmed live at this priceto cap: 1 page (14 results) — set
// well above that (and above the uncapped section's own 3 pages / 53
// results, also confirmed live) so a future growth in stock still gets
// walked in full, without an unbounded loop if the site's own pageCount is
// ever wrong/missing.
const MAX_PAGES = 150;
const PAGE_FETCH_DELAY_MS = 300; // be a polite crawler across dozens of page fetches

interface PropertyCard {
  externalID: string;
  houseName: string | null;
  displayAddress: string;
  shortDescription: string | null;
  propertyUrl: string;
  mainImageUrl: string | null;
  allImagesSrcSet?: string | null;
  formattedPrice: string | null;
  price: number;
  maximumPrice: number;
  bedrooms: number | null;
  bathrooms: number | null;
  tenure: string | null;
  postcode: string | null;
  area: string | null;
  isDevelopment: boolean;
  office?: { name?: string | null } | null;
}

interface SearchResultsFeed {
  propertyCards: PropertyCard[];
  pagination?: {
    currentPage: number;
    pageCount: number;
    totalElements: number;
    pageSize: number;
  };
}

/** Decodes the HTML entities used inside the `data-dc-search-results-list`
 * attribute's own JSON text — including numeric/named entities like
 * `&pound;` that appear inside the feed's own string values (e.g.
 * `formattedPrice`), not just the attribute-quoting entities. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&pound;/g, "£")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** Extracts and parses the `data-dc-search-results-list="{...}"` attribute
 * from one page's raw HTML. Returns null if the attribute isn't present or
 * doesn't parse — a real structural failure, not silently swallowed. */
function parseResultsFeed(html: string): SearchResultsFeed | null {
  const start = html.indexOf(RESULTS_LIST_ATTR);
  if (start === -1) return null;
  const valueStart = start + RESULTS_LIST_ATTR.length;
  const valueEnd = html.indexOf('">', valueStart);
  if (valueEnd === -1) return null;
  const raw = html.slice(valueStart, valueEnd);
  try {
    return JSON.parse(decodeHtmlEntities(raw)) as SearchResultsFeed;
  } catch {
    return null;
  }
}

function pageUrl(pageNum: number): string {
  return pageNum === 1 ? TARGET_URL : `${TARGET_URL}&page=${pageNum}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(path: string | null | undefined): string {
  if (!path) return "";
  return path.startsWith("http") ? path : `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

export const winkworthAdapter: SourceAdapter = {
  id: SOURCE_ID, // must match the id in london-developers.json exactly
  name: "Winkworth",

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

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Winkworth search-results page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Winkworth search-results page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      const firstFeed = parseResultsFeed(initialHtml);
      if (!firstFeed) {
        throw new Error(
          `Winkworth search-results page (${TARGET_URL}) returned HTTP ${httpStatus} but no ` +
            `data-dc-search-results-list feed was found — the page's structure may have changed.`
        );
      }

      const totalElements = firstFeed.pagination?.totalElements ?? null;
      const declaredPageCount = firstFeed.pagination?.pageCount ?? null;
      console.warn(
        `[winkworth] page 1: ${firstFeed.propertyCards.length} card(s); site reports ${totalElements ?? "?"} ` +
          `total result(s) across ${declaredPageCount ?? "?"} page(s)`
      );

      const allCards: PropertyCard[] = [...firstFeed.propertyCards];
      let pagesVisited = 1;
      const pageCap = declaredPageCount ? Math.min(MAX_PAGES, declaredPageCount) : MAX_PAGES;

      for (let pageNum = 2; pageNum <= pageCap; pageNum++) {
        await delay(PAGE_FETCH_DELAY_MS);
        let pageHtml: string;
        try {
          const res = await page.request.get(pageUrl(pageNum), { timeout: GOTO_TIMEOUT_MS });
          if (!res.ok()) {
            console.warn(`[winkworth] page ${pageNum}: HTTP ${res.status()} — stopping`);
            break;
          }
          pageHtml = await res.text();
        } catch (err) {
          console.warn(`[winkworth] page ${pageNum}: fetch failed (${err instanceof Error ? err.message : String(err)}) — stopping`);
          break;
        }

        const feed = parseResultsFeed(pageHtml);
        if (!feed || feed.propertyCards.length === 0) {
          console.warn(`[winkworth] page ${pageNum}: 0 cards — reached the end`);
          break;
        }
        allCards.push(...feed.propertyCards);
        pagesVisited = pageNum;
        if (pageNum % 10 === 0) {
          console.warn(`[winkworth] walked ${pageNum}/${pageCap} page(s) so far, ${allCards.length} card(s) collected`);
        }
      }
      if (pagesVisited >= MAX_PAGES) {
        console.warn(`[winkworth] hit the ${MAX_PAGES}-page safety cap`);
      }

      console.warn(
        `[winkworth] walked ${pagesVisited} page(s) in total, ${allCards.length} card(s) collected ` +
          `(site reported ${totalElements ?? "?"} total result(s))`
      );

      // CRITICAL new-build filter: bypassed for this source when
      // trustAsNewBuild is set (see file header) — every card collected is
      // kept and stored with `isNewBuild: true`, no per-listing
      // hasExplicitNewBuildSignal() check at all. When NOT trusted (a
      // future non-trusted estate-agent source reusing this same shape),
      // the discard filter still runs as it did before.
      const trusted = trustsAsNewBuild(SOURCE_ID);
      console.warn(
        `[winkworth] trustAsNewBuild: ${trusted} — ${trusted ? "keeping every card, no discard filter" : "applying hasExplicitNewBuildSignal filter"}`
      );

      const listings: AdapterListing[] = [];
      let discardedResale = 0;
      let skippedNoPriceOrUrl = 0;
      const seenIds = new Set<string>();

      for (const card of allCards) {
        if (seenIds.has(card.externalID)) continue; // same card can recur across a page boundary
        seenIds.add(card.externalID);

        if (!trusted) {
          const textHaystack = [card.houseName, card.displayAddress, card.shortDescription]
            .filter((v): v is string => !!v)
            .join(" ");
          const isNewBuild = hasExplicitNewBuildSignal(textHaystack, { structuredSignal: card.isDevelopment === true });
          if (!isNewBuild) {
            discardedResale++;
            continue;
          }
        }

        if (!card.propertyUrl || !(card.price > 0)) {
          skippedNoPriceOrUrl++;
          continue; // no honest price/url — never invent one
        }

        const url = absoluteUrl(card.propertyUrl);
        const mainImage = card.mainImageUrl ? absoluteUrl(card.mainImageUrl) : null;
        const title = card.houseName ? `${card.houseName}, ${card.displayAddress}` : card.displayAddress;
        const priceDisplay = card.formattedPrice ? decodeHtmlEntities(card.formattedPrice) : `£${card.price.toLocaleString("en-GB")}`;
        const priceRange =
          card.maximumPrice > 0 && card.maximumPrice > card.price
            ? `£${card.price.toLocaleString("en-GB")} - £${card.maximumPrice.toLocaleString("en-GB")}`
            : null;
        const area = (card.office?.name && card.office.name.trim()) || card.area || "";

        listings.push({
          externalId: `winkworth-${card.externalID}`,
          title,
          price: priceDisplay,
          priceValue: card.price,
          priceRange,
          url,
          images: mainImage ? [mainImage] : [],
          mainImage,
          bedrooms: typeof card.bedrooms === "number" ? card.bedrooms : null,
          bedroomType: null, // not published per room
          // Real structured field on this feed (confirmed live 2026-08) —
          // never derived from bedroom count.
          bathrooms: typeof card.bathrooms === "number" ? card.bathrooms : null,
          tenure: detectTenure(`${card.tenure ?? ""} ${card.shortDescription ?? ""}`),
          // true unconditionally when trusted (see trustAsNewBuild above);
          // otherwise only ever reaches here on a genuine positive signal
          // from the filter above.
          isNewBuild: true,
          postcode: (card.postcode ?? "").trim(),
          area,
        });
      }

      console.warn(
        `[winkworth] ${trusted ? "trustAsNewBuild" : "new-build filter"}: ${listings.length} kept, ` +
          `${discardedResale} discarded as resale, ${skippedNoPriceOrUrl} skipped for missing price/url, ` +
          `out of ${allCards.length} card(s) collected`
      );

      // A genuinely empty result here (0 kept) is an honest, valid outcome
      // for this source — even the dedicated new-homes section could in
      // principle turn up nothing that passes the safety-net filter — never
      // treated as a failure on its own. Only a total extraction failure (0
      // cards collected at all) is.
      if (allCards.length === 0) {
        throw new Error(
          `Winkworth search-results page (${TARGET_URL}) returned HTTP ${httpStatus} and walked ` +
            `${pagesVisited} page(s), but collected 0 property cards at all — the feed's structure may have changed.`
        );
      }

      return { httpStatus, listings, extractionMethod: "network-json" };
    } finally {
      await context.close();
    }
  },
};
