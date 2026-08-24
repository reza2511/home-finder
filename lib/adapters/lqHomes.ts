/**
 * Dedicated adapter for L&Q (lqhomes.com) — no mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes another one (no URL-discovery, unlike the generic
 * auto-adapter — see createAutoAdapter in autoAdapter.ts):
 *
 *   https://lqhomes.com/search/?location=London%2C%20UK&place
 *
 * Confirmed live (2026-08) by capturing this page's own network traffic:
 * results are NOT server-rendered — the page fires two kinds of real,
 * public, unauthenticated JSON requests once loaded:
 *
 *   1. GET /wp-json/custom/developments — every current L&Q development
 *      nationwide (id, name, address incl. postcode, featured image,
 *      live/retired flags). NOTE: the URL's `location=London` param does
 *      NOT actually filter this — the site's own "place" param (a Google
 *      Places id) is what would, and it's empty in the given URL — so this
 *      genuinely returns developments across the whole country (confirmed:
 *      Manchester, Reading, Preston, Cambridge, Cheshire, Bedford, Rugby
 *      alongside real London ones). isLondonDevelopment() below filters to
 *      London using the same postcode-area logic as autoAdapter.ts's
 *      discovered-URL path (lib/adapters/londonPostcodes.ts) — never
 *      guessed, and this app is London-only.
 *
 *   2. GET /wp-json/custom/development/{id}/properties — one call per
 *      development, each development's real individual plots (price, share
 *      price for shared ownership, bedrooms, tenure, a specific photo, a
 *      specific URL).
 *
 * The page fires the properties call for most developments automatically on
 * load; a handful only fire once their card scrolls into view (confirmed
 * live: 20 of 24 developments captured passively, 4 only after scrolling/
 * were still missing after that — no actual "load more" button exists, it's
 * viewport-triggered). Rather than depend on fully replicating whatever
 * viewport heuristic the front-end uses, every development id from response
 * #1 that never produced a captured properties response is fetched directly
 * via the same real endpoint, through the same browser session — this is
 * the identical public API the page itself calls, just invoked directly
 * instead of waiting for a scroll to trigger it, so coverage is complete
 * without guessing at data.
 *
 * `development.price_from`/`price_to` are NOT used for `priceRange` — they
 * turned out to be full of placeholder sentinels live (e.g. "0" to
 * "1000000000", or "1000000" as an apparent no-upper-limit marker) mixed in
 * with a few genuine ones, with no reliable way to tell them apart. Instead
 * `priceRange` is computed from the real per-plot prices this adapter
 * actually extracted for that development — real data derived from real
 * data, never trusting an unreliable upstream field.
 *
 * Bathrooms/floor: each plot's own `acf.plot_bathrooms`/`acf.plot_floor`
 * are real structured integer fields (confirmed live 2026-08) — used
 * directly, never derived from bedroom count or guessed.
 *
 * Fallback order if the JSON API's shape ever changes: (a) parse the
 * rendered HTML's own `.c-development-card` cards, (b) AI extraction on the
 * rendered HTML via the same extractWithAi() the generic auto-adapter uses
 * (lib/adapters/autoAdapter.ts) — reusing it rather than duplicating it.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { extractWithAi, type RawExtractedItem } from "./autoAdapter";
import { postcodeAreaIsLondon } from "./londonPostcodes";
import { detectTenure } from "./tenureDetection";
import { detectIsNewBuild } from "./newBuildDetection";
import { withBrowser } from "./browser";

const TARGET_URL = "https://lqhomes.com/search/?location=London%2C%20UK&place";
const BASE_URL = "https://lqhomes.com";
const GOTO_TIMEOUT_MS = 60_000;
const RESULTS_SELECTOR_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEVELOPMENTS_ENDPOINT_RE = /\/wp-json\/custom\/developments(?:$|\?)/;
const PROPERTIES_ENDPOINT_RE = /\/wp-json\/custom\/development\/(\d+)\/properties/;

const ANALYTICS_DOMAIN_RE =
  /google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|google\.com\/pagead|connect\.facebook\.net|facebook\.com\/tr|cookie-script\.com|hotjar\.com|clarity\.ms|criteo\.com/i;

async function blockHeavyResources(page: import("playwright-core").Page): Promise<void> {
  await page.route("**/*", (route) => {
    const request = route.request();
    const type = request.resourceType();
    if (type === "image" || type === "font") return route.abort();
    if (ANALYTICS_DOMAIN_RE.test(request.url())) return route.abort();
    return route.continue();
  });
}

// ---------- L&Q API response shapes (only the fields actually used) ----------

interface LqLocation {
  address?: string;
  city?: string;
  post_code?: string;
}

interface LqDevelopment {
  id: string;
  name: string;
  site_live?: boolean;
  site_retired?: boolean;
  site_sunsetted?: boolean;
  development_location?: LqLocation;
  featured_image?: { url?: string };
}

interface LqPropertyAcf {
  plot_price?: string;
  plot_share_price?: string;
  plot_min_share?: string;
  plot_type?: string;
  plot_tenure?: string;
  plot_bedrooms?: string;
  plot_bathrooms?: string;
  plot_floor?: string;
  plot_number?: string;
  building_name?: string;
  plot_featured_image?: { url?: string };
}

interface LqProperty {
  ID: number;
  post_title?: string;
  post_status?: string;
  guid?: string;
  acf?: LqPropertyAcf;
}

// ---------- small parsing helpers ----------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePositiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatGbp(n: number): string {
  return `£${n.toLocaleString("en-GB")}`;
}

function parseBedrooms(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/studio/i.test(raw)) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Generic non-negative-integer parser for `acf.plot_bathrooms`/
 * `plot_floor` — unlike parseBedrooms there's no "studio" text to handle,
 * but 0 (no bathroom count stated as such never happens, but floor 0 =
 * ground) is still a valid real value, so an empty/absent string is
 * distinguished from it explicitly rather than relying on parseInt("")
 * being falsy. */
function parseCount(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// A full UK postcode, or just the outward/district code (e.g. "UB3") when
// that's all a development's address publishes — both seen live.
const POSTCODE_IN_ADDRESS_RE = /([A-Z]{1,2}\d[A-Z\d]?(?:\s?\d[A-Z]{2})?)(?=,?\s*UK\s*$)/i;

/** Real postcode/area for a development, parsed from whichever location
 * field actually has it — `development_location.address` (a full Google-
 * formatted string) was the only field reliably present across every
 * development seen live; the structured `post_code`/`city` sub-fields were
 * frequently missing even when `address` had the full text. */
function locationFor(dev: LqDevelopment): { postcode: string; area: string } {
  const loc = dev.development_location;
  const address = loc?.address ?? "";
  const postcodeMatch = address.match(POSTCODE_IN_ADDRESS_RE);
  const postcode = postcodeMatch ? postcodeMatch[1].toUpperCase() : (loc?.post_code ?? "");
  const area = loc?.city ?? address.replace(/,?\s*UK\s*$/i, "").trim();
  return { postcode, area };
}

function isLondonDevelopment(dev: LqDevelopment): boolean {
  const { postcode, area } = locationFor(dev);
  if (postcode && postcodeAreaIsLondon(postcode)) return true;
  return /\blondon\b/i.test(`${area} ${dev.development_location?.address ?? ""}`);
}

interface BuiltListing {
  listing: AdapterListing;
  developmentId: string;
}

/** Builds one AdapterListing per real, published property/plot. Returns
 * null for a property with no purchase price we can honestly report at all
 * (some London Living Rent / Rent-to-Buy plots publish only a monthly rent,
 * no purchase price or share price) — never repurposes a rent figure as a
 * sale price, and never guesses one. */
function buildListing(dev: LqDevelopment, prop: LqProperty, devArea: { postcode: string; area: string }): BuiltListing | null {
  if (prop.post_status && prop.post_status !== "publish") return null;

  const acf = prop.acf ?? {};
  const isSharedOwnership = acf.plot_type === "shared_ownership";
  const sharePrice = parsePositiveNumber(acf.plot_share_price);
  const fullPrice = parsePositiveNumber(acf.plot_price);

  let priceValue: number;
  let priceText: string;
  if (isSharedOwnership && sharePrice != null) {
    const sharePct = acf.plot_min_share ? ` (${acf.plot_min_share}% share)` : "";
    priceValue = sharePrice;
    priceText = fullPrice != null
      ? `${formatGbp(sharePrice)} share${sharePct} — full value ${formatGbp(fullPrice)}`
      : `${formatGbp(sharePrice)} share${sharePct}`;
  } else if (fullPrice != null) {
    priceValue = fullPrice;
    priceText = formatGbp(fullPrice);
  } else {
    return null; // no honest purchase/share price to report — skip, never invent one
  }

  const devName = decodeHtmlEntities(dev.name);
  const plotLabel = decodeHtmlEntities(
    prop.post_title || acf.plot_number || acf.building_name || `Plot ${prop.ID}`
  );
  const url = prop.guid ? decodeHtmlEntities(prop.guid) : `${BASE_URL}/?p=${prop.ID}`;
  const image = acf.plot_featured_image?.url || dev.featured_image?.url || null;

  return {
    developmentId: dev.id,
    listing: {
      externalId: `lq-${dev.id}-${prop.ID}`,
      title: `${plotLabel}, ${devName}`,
      price: priceText,
      priceValue,
      priceRange: null, // filled in per-development after all its plots are built — see run()
      url,
      images: image ? [image] : [],
      mainImage: image,
      bedrooms: parseBedrooms(acf.plot_bedrooms),
      bedroomType: null, // not published per room
      // Real structured acf fields, confirmed live — never derived.
      bathrooms: parseCount(acf.plot_bathrooms),
      floor: parseCount(acf.plot_floor),
      // L&Q's own `plot_tenure` field says "Leasehold" even on shared-
      // ownership plots (confirmed live) — the structural leasehold detail
      // isn't the tenure category that matters here, so `plot_type`'s
      // explicit "shared_ownership" wins outright over that text.
      tenure: detectTenure(acf.plot_tenure, { forceSharedOwnership: isSharedOwnership }),
      // No free-text description published per plot here (checked directly
      // — acf only has structured fields) — detectIsNewBuild still runs
      // over whatever real text exists (plot label + development name)
      // rather than being hardcoded, defaulting true since L&Q sells shared
      // ownership/new-build homes only, never resale, on this site.
      isNewBuild: detectIsNewBuild(`${plotLabel} ${devName}`).isNewBuild,
      postcode: devArea.postcode,
      area: devArea.area,
    },
  };
}

// ---------- fallback strategies (only reached if the JSON API is empty) ----------

const PRICE_TEXT_RE = /£\s?\d[\d,]{2,}/;

/** Minimal HTML-card fallback, scoped to this site's own `.c-development-
 * card` markup (confirmed live) rather than a generic heuristic — only
 * reached if the JSON API's shape has changed and returned nothing usable. */
function extractFromRenderedCards(html: string): RawExtractedItem[] {
  const $ = cheerio.load(html);
  const items: RawExtractedItem[] = [];

  $(".c-development-card").each((_, el) => {
    const $card = $(el);
    const text = $card.text().replace(/\s+/g, " ").trim();
    const priceMatch = text.match(PRICE_TEXT_RE);
    if (!priceMatch) return;
    const priceValue = parseFloat(priceMatch[0].replace(/[£,]/g, ""));
    if (!Number.isFinite(priceValue) || priceValue <= 0) return;

    const name = $card.find(".c-development-card__title").first().text().trim();
    const href = $card.is("a") ? $card.attr("href") : $card.find("a[href]").first().attr("href");
    const url = href ? new URL(href, BASE_URL).toString() : null;
    if (!name || !url) return;

    const imgSrc = $card.find("img").first().attr("src") || $card.find("img").first().attr("data-src") || null;
    const postcodeMatch = text.match(/[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/i);
    const bedMatch = text.match(/(\d+)\s*bed/i);

    items.push({
      name,
      url,
      priceValue,
      priceText: priceMatch[0],
      bedrooms: bedMatch ? parseInt(bedMatch[1], 10) : null,
      postcode: postcodeMatch ? postcodeMatch[0].toUpperCase() : null,
      image: imgSrc ? new URL(imgSrc, BASE_URL).toString() : null,
      tenure: detectTenure(text),
      rawText: text,
    });
  });

  return items;
}

export const lqHomesAdapter: SourceAdapter = {
  id: "lq-homes", // must match the id in london-developers.json exactly
  name: "L&Q",

  async run(): Promise<AdapterRunResult> {
    // Own browser instance for this one call, always closed after — see
    // lib/adapters/browser.ts's own doc comment for why this replaced a
    // shared, never-closed singleton.
    return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });

    try {
      const page = await context.newPage();
      await blockHeavyResources(page);

      // ---- network capture: every xhr/fetch request, and the two real
      // data endpoints' JSON bodies specifically ----
      const requestLog: { method: string; url: string }[] = [];
      let developmentsJson: LqDevelopment[] | null = null;
      const propertiesByDevId = new Map<string, LqProperty[]>();

      page.on("request", (req) => {
        if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
          requestLog.push({ method: req.method(), url: req.url() });
        }
      });
      page.on("response", (res) => {
        const url = res.url();
        if (DEVELOPMENTS_ENDPOINT_RE.test(url)) {
          res
            .json()
            .then((json) => {
              if (Array.isArray(json)) developmentsJson = json as LqDevelopment[];
            })
            .catch(() => {});
          return;
        }
        const m = url.match(PROPERTIES_ENDPOINT_RE);
        if (m) {
          res
            .json()
            .then((json) => {
              if (Array.isArray(json)) propertiesByDevId.set(m[1], json as LqProperty[]);
            })
            .catch(() => {});
        }
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "L&Q search page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`L&Q search page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      // Wait for real results to appear, not just DOM-attached — 30s, logged
      // (not thrown) on a miss, since the JSON-capture path below doesn't
      // actually depend on the DOM having rendered them.
      let resultsAppeared = true;
      try {
        await page.waitForSelector(".c-development-card, text=/£\\s?\\d/", { timeout: RESULTS_SELECTOR_TIMEOUT_MS });
      } catch {
        resultsAppeared = false;
        console.warn(`[lq-homes] no result card / £-price appeared within ${RESULTS_SELECTOR_TIMEOUT_MS}ms`);
      }

      // Handle infinite scroll / viewport-triggered loading: scroll to the
      // bottom repeatedly until the page stops growing and no new
      // development-properties requests have fired for a full cycle.
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
      // A "load more"/"show more" control, if the site ever adds one — none
      // was found live (confirmed: results load purely on scroll), but
      // click through it defensively if one appears in future.
      const loadMoreButton = page.getByRole("button", { name: /load more|show more/i });
      for (let i = 0; i < 5; i++) {
        if (!(await loadMoreButton.first().isVisible().catch(() => false))) break;
        await loadMoreButton.first().click().catch(() => {});
        await page.waitForTimeout(1200);
      }

      await page.waitForTimeout(1000);
      const renderedHtml = await page.content();

      // Ensure completeness: fetch (through the same real, live session)
      // any development's properties endpoint that never got captured
      // passively — same public API the page itself calls, see file header.
      if (developmentsJson) {
        for (const dev of developmentsJson as LqDevelopment[]) {
          if (propertiesByDevId.has(dev.id)) continue;
          try {
            const url = `${BASE_URL}/wp-json/custom/development/${dev.id}/properties`;
            requestLog.push({ method: "GET (direct, gap-fill)", url });
            const res = await page.request.get(url);
            if (res.ok()) {
              const json = await res.json();
              if (Array.isArray(json)) propertiesByDevId.set(dev.id, json as LqProperty[]);
            }
          } catch (err) {
            console.warn(
              `[lq-homes] gap-fill fetch failed for development ${dev.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      console.warn(
        `[lq-homes] ${requestLog.length} xhr/fetch request(s); developments endpoint ` +
          `${developmentsJson ? "found" : "NOT found"}` +
          (developmentsJson ? ` (${(developmentsJson as LqDevelopment[]).length} developments)` : "") +
          `; properties captured for ${propertiesByDevId.size} development(s)`
      );
      for (const r of requestLog) console.warn(`[lq-homes]   ${r.method} ${r.url}`);

      let listings: AdapterListing[] = [];
      let extractionMethod = "network-json";

      if (developmentsJson) {
        const devs = (developmentsJson as LqDevelopment[]).filter(
          (d) => d.site_live !== false && !d.site_retired && !d.site_sunsetted
        );
        const londonDevs = devs.filter(isLondonDevelopment);

        for (const dev of londonDevs) {
          const properties = propertiesByDevId.get(dev.id) ?? [];
          const devArea = locationFor(dev);
          const built = properties
            .map((p) => buildListing(dev, p, devArea))
            .filter((b): b is BuiltListing => b !== null);

          if (built.length === 0) continue;

          // priceRange from the real prices actually extracted for this
          // development — never from the unreliable price_from/price_to
          // fields (see file header).
          const prices = built.map((b) => b.listing.priceValue);
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          const priceRange = max > min ? `${formatGbp(min)} - ${formatGbp(max)}` : null;

          for (const b of built) {
            listings.push({ ...b.listing, priceRange });
          }
        }
      }

      // Fallback (a): parse the rendered HTML's own result cards, in case
      // the JSON API's shape changed and returned nothing usable.
      if (listings.length === 0) {
        const cardItems = extractFromRenderedCards(renderedHtml);
        const londonCardItems = cardItems.filter(
          (item) =>
            (item.postcode && postcodeAreaIsLondon(item.postcode)) ||
            /\blondon\b/i.test(`${item.name} ${item.url}`)
        );
        if (londonCardItems.length > 0) {
          extractionMethod = "html-card-fallback";
          listings = londonCardItems.map((item, i) => ({
            externalId: `lq-card-${i}-${new URL(item.url!).pathname.replace(/\W+/g, "-")}`,
            title: item.name!,
            price: item.priceText ?? formatGbp(item.priceValue!),
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
            (item.postcode && postcodeAreaIsLondon(item.postcode)) ||
            /\blondon\b/i.test(`${item.name} ${item.url}`)
        );
        if (londonAiRaw.length > 0) {
          extractionMethod = "ai_extraction";
          listings = londonAiRaw.map((item, i) => ({
            externalId: `lq-ai-${i}-${new URL(item.url!).pathname.replace(/\W+/g, "-")}`,
            title: item.name!,
            price: item.priceText ?? formatGbp(item.priceValue!),
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
          console.warn(`[lq-homes] AI extraction fallback: ${attempted.join(", ") || "not attempted"}`);
        }
      }

      if (listings.length === 0) {
        throw new Error(
          `L&Q search page (${TARGET_URL}) returned HTTP ${httpStatus}` +
            (resultsAppeared ? "" : " and no result card/price ever appeared") +
            `. Network capture found ${developmentsJson ? (developmentsJson as LqDevelopment[]).length : 0} ` +
            `development(s) (${propertiesByDevId.size} with captured properties), but 0 produced a usable ` +
            `London listing with a real price after JSON parsing, the HTML-card fallback, and AI extraction.`
        );
      }

      return { httpStatus, listings, extractionMethod };
    } finally {
      await context.close();
    }
    });
  },
};
