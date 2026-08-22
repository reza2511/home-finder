/**
 * Dedicated adapter for Berkeley Group (berkeleygroup.co.uk) — no mock/sample
 * data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery, unlike the generic
 * auto-adapter — see createAutoAdapter in autoAdapter.ts):
 *
 *   https://www.berkeleygroup.co.uk/search-results?location=London%2C%20England&bedrooms=&propertyType=&price=
 *
 * Confirmed live (2026-08) by capturing this page's own network traffic:
 * results are NOT server-rendered — the page fires real, public,
 * unauthenticated JSON requests once loaded:
 *
 *   1. GET /search_api/developmentsresults/list?...&location=London,+England
 *      &latitude=...&longitude=...&boundaryEntityType=AdminDivision2&
 *      hasLocBoundary=true — every development id Berkeley considers to
 *      match the search (its own lat/long + boundary params, computed
 *      client-side and captured here rather than hardcoded — see below).
 *      NOTE: like L&Q's `location` param, this does NOT actually restrict
 *      results to Greater London — confirmed live: 50 development ids came
 *      back, only 29 of which have a real London postcode; the rest are
 *      Reading, Guildford, Birmingham, Bath, Milton Keynes, etc. (Berkeley's
 *      wider group operating area). `isLondonAddress()` below filters using
 *      the same postcode-area logic as the other dedicated adapters
 *      (lib/adapters/londonPostcodes.ts) — never guessed.
 *
 *   2. GET /search_api/developments/details?developmentId={id}&status= —
 *      one call per development: real name, real full address (incl.
 *      postcode), a real published `priceRange` string (e.g. "£680,000 -
 *      £2,275,000", sometimes a single figure with no dash, sometimes the
 *      literal text "Prices not released"), a real preview image, and the
 *      real "View Development" page URL.
 *
 *   3. GET /search_api/properties?noOfItemsPerPage={n}&dataSourcePageId=
 *      {id}&... — one call per development: its real individual properties
 *      (price, bedrooms, floor, sqft, status, its own page URL).
 *
 * The page only fires #2/#3 passively for whichever development card is
 * currently in view (confirmed live: 1 of 50 captured passively after
 * loading + scrolling, same viewport-triggered behaviour as L&Q) — no actual
 * "load more"/pagination exists on the search-results page itself (the #1
 * response already contains the complete unpaginated result set), so rather
 * than depend on replicating the viewport heuristic, #2 and #3 are called
 * directly for every development id from #1, through the same real browser
 * session, exactly the endpoints the page itself calls.
 *
 * One AdapterListing per DEVELOPMENT (not per individual plot, unlike L&Q) —
 * this is what the task/data actually supports: Berkeley's own `priceRange`
 * string is the real, developer-published range for the whole development,
 * per instruction stored as `price` = its starting (floor) figure and the
 * full string kept in `priceRange`. `bedrooms` (and, when that same
 * property's own real `propertyfloor` field states one, `floor` — e.g. "9",
 * blank on houses, confirmed live) are filled in from whichever of that
 * development's real individual properties (#3) has the lowest parseable
 * price — i.e. the actual home the floor price refers to (confirmed live:
 * that property's own price always matches the development's published
 * floor price exactly) — left null if that can't be determined honestly
 * (e.g. the cheapest property has no bedroom count, or no properties were
 * returned at all).
 *
 * Tenure is never stated anywhere in this JSON (checked directly: no field
 * on either endpoint, and none of the 29 London developments' name/address/
 * propertyTypes/description text mentions "leasehold"/"freehold"/"shared
 * ownership" either) — `detectTenure()` runs over that combined text for
 * forward-compatibility, but currently every Berkeley listing's tenure comes
 * back null, never guessed from london-developers.json's directory-level
 * `tenures: ["leasehold", "freehold"]` (that's what Berkeley sells across
 * its portfolio in general, not a per-listing fact this adapter can state).
 *
 * A development is skipped (not included, with the reason logged) when its
 * `priceRange` string contains no parseable £ figure at all — seen live as
 * "Prices not released" — never inventing a price to fill the gap.
 *
 * Fallback order if the JSON API's shape ever changes: (a) parse the
 * rendered HTML's own `.development-list--search li .wrapper` cards
 * (confirmed live), handling the page's viewport-triggered lazy-loading via
 * repeated scrolling, (b) AI extraction on the rendered HTML via the same
 * extractWithAi() the generic auto-adapter uses (lib/adapters/autoAdapter.ts)
 * — reusing it rather than duplicating it.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { extractWithAi, type RawExtractedItem } from "./autoAdapter";
import { postcodeAreaIsLondon } from "./londonPostcodes";
import { detectTenure } from "./tenureDetection";
import { detectIsNewBuild } from "./newBuildDetection";
import { getSharedBrowser } from "./browser";

const TARGET_URL =
  "https://www.berkeleygroup.co.uk/search-results?location=London%2C%20England&bedrooms=&propertyType=&price=";
const BASE_URL = "https://www.berkeleygroup.co.uk";
const GOTO_TIMEOUT_MS = 60_000;
const RESULTS_SELECTOR_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LIST_ENDPOINT_RE = /\/search_api\/developmentsresults\/list(?:$|\?)/;
const DETAILS_ENDPOINT_RE = /\/search_api\/developments\/details\?developmentId=([^&]+)/;
const PROPERTIES_ENDPOINT_RE = /\/search_api\/properties\?.*dataSourcePageId=([^&]+)/;

const ANALYTICS_DOMAIN_RE =
  /google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|connect\.facebook\.net|facebook\.com\/tr|onetrust\.com|sitecorecloud\.io|virtualearth\.net|livechatinc\.com|hotjar\.com|clarity\.ms|criteo\.com/i;

async function blockHeavyResources(page: import("playwright-core").Page): Promise<void> {
  await page.route("**/*", (route) => {
    const request = route.request();
    const type = request.resourceType();
    if (type === "image" || type === "font") return route.abort();
    if (ANALYTICS_DOMAIN_RE.test(request.url())) return route.abort();
    return route.continue();
  });
}

// ---------- Berkeley API response shapes (only the fields actually used) ----------

interface BerkeleyListItem {
  developmentId: string;
  developmentNoOfProperties: number;
}

interface BerkeleyListResponse {
  status: string;
  data?: { items?: BerkeleyListItem[] };
}

interface BerkeleyDevelopmentDetails {
  name?: string;
  address?: string;
  status?: string;
  propertyTypes?: string;
  priceRange?: string;
  shortDescription?: string;
  viewDevelopmentButton?: { url?: string };
  previewImage?: { path?: string };
}

interface BerkeleyDetailsResponse {
  status: string;
  data?: BerkeleyDevelopmentDetails;
}

interface BerkeleyPropertyItem {
  button?: { url?: string };
  fields?: {
    propertyprice?: string;
    propertynoofbedrooms?: string;
    propertyfloor?: string;
  };
}

interface BerkeleyPropertiesResponse {
  status: string;
  data?: { items?: BerkeleyPropertyItem[] };
}

// ---------- small parsing helpers ----------

// Full UK postcode embedded anywhere in a free-text address, e.g.
// "Oval, SE11 5QY" or "Fulham, London, SW6 3DS" — Berkeley always publishes
// the complete inward+outward code (confirmed live across all 29 London
// developments), unlike L&Q which sometimes only had the outward code.
const POSTCODE_IN_ADDRESS_RE = /([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})/i;

function locationFor(address: string | undefined): { postcode: string; area: string } {
  const addr = (address ?? "").trim();
  const m = addr.match(POSTCODE_IN_ADDRESS_RE);
  if (!m) return { postcode: "", area: addr };
  const postcode = m[1].toUpperCase();
  const area = `${addr.slice(0, m.index)}${addr.slice((m.index ?? 0) + m[0].length)}`
    .replace(/,\s*$/, "")
    .replace(/^\s*,/, "")
    .trim();
  return { postcode, area };
}

function isLondonAddress(address: string | undefined): boolean {
  const { postcode, area } = locationFor(address);
  if (postcode && postcodeAreaIsLondon(postcode)) return true;
  return /\blondon\b/i.test(`${area} ${address ?? ""}`);
}

const PRICE_FIGURE_RE = /£\s?[\d,]+/g;

/** Parses a Berkeley `priceRange` string into a starting figure plus (when a
 * real upper bound is stated) the full range text. Returns null when there's
 * no honest £ figure to report at all — seen live as the literal text
 * "Prices not released" — never inventing a price to fill that gap. Not
 * driven by the API's own `pricesNotReleased` flag: that flag was confirmed
 * live to be `true` on developments that DO publish a real two-figure range
 * (e.g. Fulham Reach: "£549,500 - £2,200,000") — unreliable, so the actual
 * price text is what's trusted instead. */
function parsePriceRange(raw: string | undefined): { priceValue: number; price: string; priceRange: string | null } | null {
  const figures = (raw ?? "").match(PRICE_FIGURE_RE);
  if (!figures || figures.length === 0) return null;
  const priceValue = parseFloat(figures[0].replace(/[£,\s]/g, ""));
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  return {
    priceValue,
    price: figures[0].replace(/\s+/g, ""),
    priceRange: figures.length >= 2 ? raw!.trim() : null,
  };
}

function parseBedrooms(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/studio/i.test(raw)) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parsePropertyPrice(raw: string | undefined): number | null {
  if (!raw) return null; // some properties (e.g. "Reserved") publish no price
  const n = parseFloat(raw.replace(/[£,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Real per-property floor number (e.g. "9", "12") — blank on houses and on
 * some flats (confirmed live), never guessed when absent. Unlike bedrooms,
 * 0 is a valid floor (ground), so an empty string is distinguished from it
 * explicitly rather than relying on parseInt("") being falsy. */
function parseFloor(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** The real bedroom count AND floor of whichever of a development's actual
 * properties has the lowest real price — i.e. the specific home the
 * development's own published floor price refers to. Both null when no
 * property has both a parseable price and that field. */
function bestPropertyForStartingPrice(
  items: BerkeleyPropertyItem[]
): { bedrooms: number | null; floor: number | null } {
  let best: { price: number; bedrooms: number | null; floor: number | null } | null = null;
  for (const item of items) {
    const price = parsePropertyPrice(item.fields?.propertyprice);
    const bedrooms = parseBedrooms(item.fields?.propertynoofbedrooms);
    if (price == null || bedrooms == null) continue;
    if (!best || price < best.price) best = { price, bedrooms, floor: parseFloor(item.fields?.propertyfloor) };
  }
  return { bedrooms: best?.bedrooms ?? null, floor: best?.floor ?? null };
}

// ---------- fallback strategies (only reached if the JSON API is empty) ----------

/** Minimal HTML-card fallback, scoped to this site's own
 * `.development-list--search li .wrapper[data-id]` markup (confirmed live)
 * rather than a generic heuristic — only reached if the JSON API's shape has
 * changed and returned nothing usable. Cards only fully populate as they
 * scroll into view, so the caller scrolls first (see run()). */
function extractFromRenderedCards(html: string): RawExtractedItem[] {
  const $ = cheerio.load(html);
  const items: RawExtractedItem[] = [];

  $(".development-list--search > li .wrapper[data-id]").each((_, el) => {
    const $card = $(el);
    const name = $card.find(".info-wrapper h2").first().text().trim();
    const address = $card.find(".info-wrapper .address").first().text().trim();
    const priceText = $card.find(".details-content").text();
    const parsed = parsePriceRange(priceText);
    if (!name || !parsed) return;

    const href = $card.find(".cta-wrapper a.button--primary").first().attr("href");
    const url = href ? new URL(href, BASE_URL).toString() : null;
    if (!url) return;

    const imgSrc = $card.find("img").first().attr("src") || null;
    const { postcode } = locationFor(address);

    items.push({
      name,
      url,
      priceValue: parsed.priceValue,
      priceText: parsed.price,
      bedrooms: null, // not present on the list card itself, only per-property
      postcode: postcode || null,
      image: imgSrc ? new URL(imgSrc, BASE_URL).toString() : null,
      tenure: detectTenure(`${name} ${address} ${priceText}`),
      rawText: `${name} ${address} ${priceText}`,
    });
  });

  return items;
}

export const berkeleyAdapter: SourceAdapter = {
  id: "berkeley", // must match the id in london-developers.json exactly
  name: "Berkeley Group",

  async run(): Promise<AdapterRunResult> {
    const browser = await getSharedBrowser();
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });

    try {
      const page = await context.newPage();
      await blockHeavyResources(page);

      // ---- network capture: every xhr/fetch request, and the search
      // results list endpoint's JSON body specifically ----
      const requestLog: { method: string; url: string }[] = [];
      let listJson: BerkeleyListResponse | null = null;

      page.on("request", (req) => {
        if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
          requestLog.push({ method: req.method(), url: req.url() });
        }
      });
      page.on("response", (res) => {
        const url = res.url();
        if (LIST_ENDPOINT_RE.test(url)) {
          res
            .json()
            .then((json) => {
              listJson = json as BerkeleyListResponse;
            })
            .catch(() => {});
        }
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Berkeley Group search page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(
          `Berkeley Group search page: unexpected HTTP ${httpStatus}`,
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }

      // Wait for a real result card, not just DOM-attached — 30s, logged
      // (not thrown) on a miss, since the JSON-capture path below doesn't
      // actually depend on the DOM having rendered them.
      let resultsAppeared = true;
      try {
        await page.waitForSelector(".development-list--search .wrapper[data-id], text=/£\\s?\\d/", {
          timeout: RESULTS_SELECTOR_TIMEOUT_MS,
        });
      } catch {
        resultsAppeared = false;
        console.warn(`[berkeley] no result card / £-price appeared within ${RESULTS_SELECTOR_TIMEOUT_MS}ms`);
      }

      // Handle infinite scroll / viewport-triggered card loading (mirrors
      // L&Q's approach) — scroll to the bottom repeatedly until the page
      // stops growing and no new xhr/fetch requests have fired for a full
      // cycle. The search-results list endpoint itself returns every
      // development in one unpaginated response (confirmed live — no
      // "load more"/pagination on this page), so this is only to give the
      // HTML-card fallback its best shot at fully-populated cards, not
      // needed for the primary JSON path below.
      let lastHeight = 0;
      let stableRounds = 0;
      for (let i = 0; i < 10 && stableRounds < 2; i++) {
        const requestsBefore = requestLog.length;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1200);
        const height = await page.evaluate(() => document.body.scrollHeight);
        const grew = height > lastHeight || requestLog.length > requestsBefore;
        lastHeight = height;
        stableRounds = grew ? 0 : stableRounds + 1;
      }
      const loadMoreButton = page.getByRole("button", { name: /load more|show more/i });
      for (let i = 0; i < 5; i++) {
        if (!(await loadMoreButton.first().isVisible().catch(() => false))) break;
        await loadMoreButton.first().click().catch(() => {});
        await page.waitForTimeout(1200);
      }

      await page.waitForTimeout(500);
      const renderedHtml = await page.content();

      console.warn(
        `[berkeley] ${requestLog.length} xhr/fetch request(s); developments list endpoint ` +
          `${listJson ? "found" : "NOT found"}` +
          (listJson
            ? ` (${(listJson as BerkeleyListResponse).data?.items?.length ?? 0} development(s) nationwide)`
            : "")
      );
      for (const r of requestLog) console.warn(`[berkeley]   ${r.method} ${r.url}`);

      let listings: AdapterListing[] = [];
      let extractionMethod = "network-json";
      let skippedNoPrice = 0;
      let skippedNonLondon = 0;

      const listItems = (listJson as BerkeleyListResponse | null)?.data?.items ?? [];

      if (listItems.length > 0) {
        // Fetch each development's real details directly through the same
        // browser session — the exact public endpoint the page itself
        // calls, just invoked for every id instead of relying on whichever
        // cards happened to scroll into view (see file header).
        for (const item of listItems) {
          let details: BerkeleyDevelopmentDetails | undefined;
          try {
            const res = await page.request.get(
              `${BASE_URL}/search_api/developments/details?developmentId=${item.developmentId}&status=`
            );
            requestLog.push({ method: "GET (direct)", url: res.url() });
            const json = (await res.json()) as BerkeleyDetailsResponse;
            details = json.data;
          } catch (err) {
            console.warn(
              `[berkeley] details fetch failed for development ${item.developmentId}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            continue;
          }
          if (!details) continue;

          if (!isLondonAddress(details.address)) {
            skippedNonLondon++;
            continue;
          }

          const parsedPrice = parsePriceRange(details.priceRange);
          if (!parsedPrice) {
            skippedNoPrice++;
            console.warn(
              `[berkeley] skipping "${details.name ?? item.developmentId}" — no parseable price ` +
                `(published priceRange: "${details.priceRange ?? "none"}")`
            );
            continue;
          }

          let bedrooms: number | null = null;
          let floor: number | null = null;
          if (item.developmentNoOfProperties > 0) {
            try {
              const propRes = await page.request.get(
                `${BASE_URL}/search_api/properties?noOfItemsPerPage=${item.developmentNoOfProperties}` +
                  `&dataSourcePageId=${item.developmentId}&status=&selectedPrice=&selectedPropertyType=&selectedNoOfBedrooms=`
              );
              requestLog.push({ method: "GET (direct)", url: propRes.url() });
              const propJson = (await propRes.json()) as BerkeleyPropertiesResponse;
              const best = bestPropertyForStartingPrice(propJson.data?.items ?? []);
              bedrooms = best.bedrooms;
              floor = best.floor;
            } catch (err) {
              console.warn(
                `[berkeley] properties fetch failed for development ${item.developmentId}: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          }

          const { postcode, area } = locationFor(details.address);
          const url = details.viewDevelopmentButton?.url
            ? new URL(details.viewDevelopmentButton.url, BASE_URL).toString()
            : null;
          if (!url) continue; // no real listing URL to link to — never invent one

          listings.push({
            externalId: `berkeley-${item.developmentId}`,
            title: details.name ?? item.developmentId,
            price: parsedPrice.price,
            priceValue: parsedPrice.priceValue,
            priceRange: parsedPrice.priceRange,
            url,
            images: details.previewImage?.path ? [details.previewImage.path] : [],
            mainImage: details.previewImage?.path ?? null,
            bedrooms,
            bedroomType: null, // not published per room
            // Same cheapest-property pick bedrooms comes from — its real
            // `propertyfloor` field (blank on houses, confirmed live).
            floor,
            tenure: detectTenure(
              `${details.name ?? ""} ${details.address ?? ""} ${details.propertyTypes ?? ""} ${
                details.shortDescription ?? ""
              }`
            ),
            isNewBuild: detectIsNewBuild(`${details.name ?? ""} ${details.shortDescription ?? ""}`).isNewBuild,
            postcode,
            area,
          });
        }
      }

      // Fallback (a): parse the rendered HTML's own result cards, in case
      // the JSON API's shape changed and returned nothing usable.
      if (listings.length === 0) {
        const cardItems = extractFromRenderedCards(renderedHtml);
        const londonCardItems = cardItems.filter(
          (item) =>
            (item.postcode && postcodeAreaIsLondon(item.postcode)) || /\blondon\b/i.test(`${item.name} ${item.url}`)
        );
        if (londonCardItems.length > 0) {
          extractionMethod = "html-card-fallback";
          listings = londonCardItems.map((item, i) => ({
            externalId: `berkeley-card-${i}-${new URL(item.url!).pathname.replace(/\W+/g, "-")}`,
            title: item.name!,
            price: item.priceText ?? `£${item.priceValue!.toLocaleString("en-GB")}`,
            priceValue: item.priceValue!,
            priceRange: null,
            url: item.url!,
            images: item.image ? [item.image] : [],
            mainImage: item.image,
            bedrooms: item.bedrooms,
            bedroomType: null,
            tenure: item.tenure,
            isNewBuild: detectIsNewBuild(item.rawText).isNewBuild,
            postcode: item.postcode ?? "",
            area: "",
          }));
        }
      }

      // Fallback (b): AI extraction on the rendered HTML — last resort,
      // reusing the generic auto-adapter's implementation rather than
      // duplicating it.
      if (listings.length === 0) {
        const attempted: string[] = [];
        const aiRaw = await extractWithAi(renderedHtml, BASE_URL, attempted);
        const londonAiRaw = aiRaw.filter(
          (item) =>
            (item.postcode && postcodeAreaIsLondon(item.postcode)) || /\blondon\b/i.test(`${item.name} ${item.url}`)
        );
        if (londonAiRaw.length > 0) {
          extractionMethod = "ai_extraction";
          listings = londonAiRaw.map((item, i) => ({
            externalId: `berkeley-ai-${i}-${new URL(item.url!).pathname.replace(/\W+/g, "-")}`,
            title: item.name!,
            price: item.priceText ?? `£${item.priceValue!.toLocaleString("en-GB")}`,
            priceValue: item.priceValue!,
            priceRange: null,
            url: item.url!,
            images: item.image ? [item.image] : [],
            mainImage: item.image,
            bedrooms: item.bedrooms,
            bedroomType: null,
            tenure: item.tenure,
            isNewBuild: detectIsNewBuild(item.rawText).isNewBuild,
            postcode: item.postcode ?? "",
            area: "",
          }));
        } else {
          console.warn(`[berkeley] AI extraction fallback: ${attempted.join(", ") || "not attempted"}`);
        }
      }

      if (listings.length === 0) {
        throw new Error(
          `Berkeley Group search page (${TARGET_URL}) returned HTTP ${httpStatus}` +
            (resultsAppeared ? "" : " and no result card/price ever appeared") +
            `. Network capture found ${listItems.length} development(s) nationwide from the search_api ` +
            `list endpoint (${skippedNonLondon} not in a London postcode, ${skippedNoPrice} with no ` +
            `parseable published price), but 0 produced a usable London listing after JSON parsing, the ` +
            `HTML-card fallback, and AI extraction.`
        );
      }

      console.warn(
        `[berkeley] built ${listings.length} London listing(s) via ${extractionMethod} ` +
          `(${skippedNonLondon} non-London development(s) skipped, ${skippedNoPrice} with no published price)`
      );

      return { httpStatus, listings, extractionMethod };
    } finally {
      await context.close();
    }
  },
};
