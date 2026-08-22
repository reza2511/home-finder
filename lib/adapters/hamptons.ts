/**
 * Dedicated adapter for Hamptons (hamptons.co.uk) — a general London estate
 * agent, NOT a developer's own site (source_type: "estate-agent" in
 * london-developers.json, trustAsNewBuild: true — see file footer). No
 * mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery):
 *
 *   https://www.hamptons.co.uk/london/london/sales/tag-new-homes/up-to-450000#/
 *
 * (Hamptons' own "new homes" tag, already filtered to that price cap — the
 * `#/` fragment is a client-side routing artifact never sent to the server;
 * `page.goto()` is still given the exact URL as specified.)
 *
 * robots.txt (https://www.hamptons.co.uk/robots.txt, checked 2026-08) has
 * no `User-agent: *` block at all — only a handful of specific bots
 * (dotbot, YandexBot, BLEXBot, etc., none of them this crawler) are
 * disallowed anything. No conflict.
 *
 * CRITICAL — network-json feed check: confirmed live by capturing every
 * xhr/fetch request this page fires (Playwright network listener) — none of
 * them is a listings API; everything is analytics/chat-widget traffic
 * (Giosg live-chat, Google/Clarity tracking). There is no network-json feed
 * here.
 *
 * What this page DOES publish, server-rendered on first load: a real
 * `<script type="application/ld+json">` block, `@type: CollectionPage`,
 * whose `mainEntity.itemListElement` is a genuine `OfferCatalog` of real
 * `Offer`s — each with a real price, currency, availability, and a
 * `PostalAddress` (street address + postcode) — confirmed live, 12 offers
 * per page. This is server-side structured data, not client-rendered, so
 * it's used directly rather than scraping the (client-JS-populated, and
 * confirmed live to still be template-placeholder text even after a 4s
 * render wait) results grid. extractionMethod: "json-ld".
 *
 * The raw JSON-LD text has real UNESCAPED newlines inside its own string
 * values (confirmed live — technically invalid JSON) — every block is
 * normalized (newlines/tabs collapsed to spaces) before JSON.parse, same
 * defensive approach as Winkworth's HTML-entity decoding for its own feed.
 *
 * CRITICAL — pagination: real, path-based — the given URL is page 1;
 * subsequent pages are the same path plus `/page-N` (confirmed live via a
 * real `href="…/page-2"` link present in page 1's own HTML, and page 2
 * genuinely returns 12 different offers with its own `/page-3` link).
 * Walked by fetching each page directly through the same Playwright session
 * (`page.request.get()`) until a page has no further `/page-N+1` link or
 * returns 0 offers, with a safety cap well above what's been seen live (5
 * pages / 51 offers at time of writing).
 *
 * Image: NOT published in the search-results JSON-LD at all (checked
 * directly — no image field on the Offer, and the static/initial HTML has
 * no image URLs anywhere either, since the visual card grid is entirely
 * client-rendered and never actually populates from this feed). Each
 * offer's own detail page DOES publish a real `<meta property="og:image">`
 * (confirmed live) — fetched once per listing (same session, no full
 * render) as the only honest way to get a real photo. This roughly doubles
 * the request count for this source; accepted as the cost of "real data
 * only, never fake" over leaving every image blank when the source
 * genuinely does publish one, just not on the list page.
 *
 * Bedrooms: the JSON-LD's `itemOffered.name` is a fixed template — e.g.
 * "1 bedroom flat for sale" (padded with extra whitespace) — parsed for a
 * single leading digit ("studio" maps to 0); genuinely ambiguous/unparsed
 * text leaves it null rather than guessed.
 *
 * Bathrooms: the same per-listing detail-page fetch used for the image
 * also carries a real `numberOfBathroomsTotal` field on its own `Offer`
 * JSON-LD (confirmed live 2026-08, schema.org's standard Accommodation
 * property) — used directly, never derived from bedroom count.
 *
 * Tenure: `detectTenure()` runs over the fuller description text pulled
 * from the same per-listing detail-page fetch used for the image (the
 * search-results JSON-LD's own text is just the template name above, never
 * enough to carry a tenure signal).
 *
 * postcode/area: `PostalAddress.postalCode` (real, full) and
 * `.streetAddress` respectively — both server-published directly, never
 * guessed.
 *
 * CRITICAL — London only: this URL's own path ("/london/london/...") is
 * trusted as the primary signal, but confirmed live it still lets real
 * Home Counties towns through the "new homes" tag (Weybridge, Radlett,
 * Epsom) — a real postcode/text backstop (lib/adapters/londonPostcodes.ts)
 * filters those out, same approach every other aggregator-style adapter in
 * this app already applies.
 *
 * trustAsNewBuild: true (this entry) — every offer collected here is kept
 * and stored as `isNewBuild: true`, no per-listing new-build
 * signal-checking — this page is already Hamptons' own "new homes" tag.
 *
 * CRITICAL — dedupe: being a non-direct source, this adapter's output is
 * deduped against every other currently-active listing (direct developers'
 * AND every other second-phase source's) before being stored — see
 * lib/adapters/dedupe.ts and lib/syncEngine.ts's isSecondPhaseSource /
 * sequential second-phase ordering.
 */
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectTenure } from "./tenureDetection";
import { postcodeAreaIsLondon } from "./londonPostcodes";
import { getSharedBrowser } from "./browser";

const SOURCE_ID = "hamptons";
const BASE_URL = "https://www.hamptons.co.uk";
const TARGET_PATH = "/london/london/sales/tag-new-homes/up-to-450000";
const TARGET_URL = `${BASE_URL}${TARGET_PATH}#/`;
const GOTO_TIMEOUT_MS = 60_000;
const DETAIL_FETCH_DELAY_MS = 250; // be a polite crawler across dozens of per-listing detail fetches
const PAGE_FETCH_DELAY_MS = 300;
const MAX_PAGES = 60; // real total confirmed live: 5 pages (51 offers) — capped well above that

interface OfferAddress {
  streetAddress?: string;
  postalCode?: string;
}
interface Offer {
  url: string;
  price: string;
  priceCurrency: string;
  itemOffered?: {
    name?: string;
    address?: OfferAddress;
  };
}
interface CollectionPage {
  mainEntity?: {
    itemListElement?: Offer[];
  };
}

/** Extracts and loosely-parses the page's own CollectionPage JSON-LD block
 * — "loosely" because the site's own markup has real unescaped newlines
 * inside string values (see file header); collapsed to spaces before
 * JSON.parse rather than failing outright on genuinely real, present data. */
function parseCollectionPage(html: string): CollectionPage | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!m[1].includes("CollectionPage")) continue;
    const cleaned = m[1].replace(/[\r\n\t]+/g, " ");
    try {
      return JSON.parse(cleaned) as CollectionPage;
    } catch {
      return null;
    }
  }
  return null;
}

function pageUrl(pageNum: number): string {
  return pageNum === 1 ? `${BASE_URL}${TARGET_PATH}` : `${BASE_URL}${TARGET_PATH}/page-${pageNum}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A single, unambiguous bedroom count from the JSON-LD's own template
 * name text (e.g. "1 bedroom flat for sale" -> 1, "Studio flat for sale"
 * -> 0). Null when it doesn't match this exact template — never guessed. */
function parseBedrooms(name: string | undefined): number | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (/^studio\b/i.test(trimmed)) return 0;
  const m = trimmed.match(/^(\d+)\s*bedroom/i);
  return m ? parseInt(m[1], 10) : null;
}

function parsePriceValue(price: string): number | null {
  const value = parseFloat(price.replace(/[£,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

interface DetailData {
  image: string | null;
  description: string;
  bathrooms: number | null;
}

/** One extra real request per listing (see file header) — plain fetch
 * through the same Playwright session, not a full re-render, just to read
 * the `og:image` meta tag and the fuller Offer description for tenure
 * text (the detail page's own JSON-LD is a bare `Offer`, not wrapped in a
 * `CollectionPage` like the search-results page — parsed directly here,
 * not via parseCollectionPage). Best-effort: a failed/odd detail page never
 * drops the listing itself, it just leaves image/description absent. */
async function fetchDetail(page: import("playwright-core").Page, url: string): Promise<DetailData> {
  try {
    const res = await page.request.get(url, { timeout: GOTO_TIMEOUT_MS });
    if (!res.ok()) return { image: null, description: "", bathrooms: null };
    const html = await res.text();
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

    let description = "";
    let bathrooms: number | null = null;
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (!m[1].includes('"Offer"')) continue;
      try {
        const cleaned = m[1].replace(/[\r\n\t]+/g, " ");
        const parsed = JSON.parse(cleaned) as {
          itemOffered?: { description?: string; numberOfBathroomsTotal?: number };
        };
        description = parsed.itemOffered?.description ?? "";
        // Real schema.org Accommodation field on this detail page's own
        // JSON-LD (confirmed live 2026-08) — never derived from bedrooms.
        const rawBathrooms = parsed.itemOffered?.numberOfBathroomsTotal;
        bathrooms = typeof rawBathrooms === "number" && Number.isFinite(rawBathrooms) ? rawBathrooms : null;
        break;
      } catch {
        // stays empty/null — never guessed
      }
    }

    return { image: imageMatch ? imageMatch[1] : null, description, bathrooms };
  } catch {
    return { image: null, description: "", bathrooms: null };
  }
}

export const hamptonsAdapter: SourceAdapter = {
  id: SOURCE_ID, // must match the id in london-developers.json exactly
  name: "Hamptons",

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
          "Hamptons new-homes page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Hamptons new-homes page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      const firstPage = parseCollectionPage(initialHtml);
      if (!firstPage?.mainEntity?.itemListElement) {
        throw new Error(
          `Hamptons new-homes page (${TARGET_URL}) returned HTTP ${httpStatus} but no CollectionPage ` +
            `JSON-LD offer catalog was found — the page's structure may have changed.`
        );
      }
      console.warn(`[hamptons] json-ld feed found: page 1 has ${firstPage.mainEntity.itemListElement.length} offer(s)`);

      const allOffers: Offer[] = [...firstPage.mainEntity.itemListElement];
      let pagesVisited = 1;
      let currentHtml = initialHtml;

      for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
        const hasNextLink = new RegExp(`page-${pageNum}"`).test(currentHtml);
        if (!hasNextLink) {
          console.warn(`[hamptons] page ${pageNum - 1}: no page-${pageNum} link — reached the end`);
          break;
        }
        await delay(PAGE_FETCH_DELAY_MS);
        let pageHtml: string;
        try {
          const res = await page.request.get(pageUrl(pageNum), { timeout: GOTO_TIMEOUT_MS });
          if (!res.ok()) {
            console.warn(`[hamptons] page ${pageNum}: HTTP ${res.status()} — stopping`);
            break;
          }
          pageHtml = await res.text();
        } catch (err) {
          console.warn(`[hamptons] page ${pageNum}: fetch failed (${err instanceof Error ? err.message : String(err)}) — stopping`);
          break;
        }

        const feed = parseCollectionPage(pageHtml);
        const offers = feed?.mainEntity?.itemListElement ?? [];
        if (offers.length === 0) {
          console.warn(`[hamptons] page ${pageNum}: 0 offers — reached the end`);
          break;
        }
        allOffers.push(...offers);
        pagesVisited = pageNum;
        currentHtml = pageHtml;
      }
      if (pagesVisited >= MAX_PAGES) {
        console.warn(`[hamptons] hit the ${MAX_PAGES}-page safety cap`);
      }
      console.warn(`[hamptons] walked ${pagesVisited} page(s) in total, ${allOffers.length} offer(s) collected`);

      const listings: AdapterListing[] = [];
      let skipped = 0;
      let skippedNonLondon = 0;
      const seenUrls = new Set<string>();

      for (const offer of allOffers) {
        if (!offer.url || seenUrls.has(offer.url)) continue;
        seenUrls.add(offer.url);

        const priceValue = parsePriceValue(offer.price ?? "");
        const address = offer.itemOffered?.address;
        if (priceValue == null || !address?.streetAddress) {
          skipped++;
          continue; // no honest price/address — never invent one
        }

        // CRITICAL — London only: this URL's own path ("/london/london/...")
        // is trusted as the primary signal, but confirmed live it still
        // lets real Home Counties towns through (Weybridge, Radlett, Epsom)
        // — same backstop applied here as every other aggregator-style
        // adapter in this app (lib/adapters/londonPostcodes.ts).
        const postcode = (address.postalCode ?? "").trim();
        const isLondon = postcodeAreaIsLondon(postcode) || /\blondon\b/i.test(address.streetAddress);
        if (!isLondon) {
          skippedNonLondon++;
          continue;
        }

        await delay(DETAIL_FETCH_DELAY_MS);
        const detail = await fetchDetail(page, offer.url);

        listings.push({
          externalId: `hamptons-${offer.url.replace(BASE_URL, "").replace(/^\/+|\/+$/g, "").replace(/\//g, "-")}`,
          title: address.streetAddress,
          price: `£${priceValue.toLocaleString("en-GB")}`,
          priceValue,
          priceRange: null, // never published — one figure per offer
          url: offer.url,
          images: detail.image ? [detail.image] : [],
          mainImage: detail.image,
          bedrooms: parseBedrooms(offer.itemOffered?.name),
          bedroomType: null, // not published per room
          bathrooms: detail.bathrooms,
          tenure: detectTenure(detail.description),
          isNewBuild: true, // trustAsNewBuild — see file header
          postcode,
          area: address.streetAddress,
        });
      }

      console.warn(
        `[hamptons] trustAsNewBuild: ${listings.length} kept, ${skipped} skipped for missing price/address, ` +
          `${skippedNonLondon} not in a London postcode/area`
      );

      if (allOffers.length === 0) {
        throw new Error(
          `Hamptons new-homes page (${TARGET_URL}) returned HTTP ${httpStatus} and walked ${pagesVisited} page(s), ` +
            `but collected 0 offers at all — the feed's structure may have changed.`
        );
      }

      return { httpStatus, listings, extractionMethod: "json-ld" };
    } finally {
      await context.close();
    }
  },
};
