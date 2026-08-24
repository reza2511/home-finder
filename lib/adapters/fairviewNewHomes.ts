/**
 * Dedicated adapter for Fairview New Homes (fairview.co.uk) — no mock/sample
 * data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery, unlike the generic
 * auto-adapter — see createAutoAdapter in autoAdapter.ts):
 *
 *   https://www.fairview.co.uk/find-your-new-home/
 *
 * robots.txt (https://www.fairview.co.uk/robots.txt) was checked first: only
 * `Disallow: /*?` (query-string URLs) — both this page and the JSON endpoint
 * below have no query string, so both are allowed.
 *
 * Confirmed live (2026-08) by capturing this page's own network traffic:
 * results are NOT server-rendered — the page fires a real, public,
 * unauthenticated JSON request once loaded:
 *
 *   GET /json/live/developments.json
 *
 * This ONE response contains every current Fairview development nationwide,
 * each with its own array of real individual plots (id, price, bedrooms,
 * floor, status, its own page URL) — the complete dataset in one shot, no
 * pagination params, no per-development follow-up call needed (unlike L&Q/
 * Berkeley). `isLondonDevelopment()` filters to London using the same
 * postcode-area logic as the other dedicated adapters
 * (lib/adapters/londonPostcodes.ts) — confirmed live: of 9 developments, 4
 * have real plots at all (the rest are "Coming Soon" with an empty `plots`
 * array), and of those 4 one (Wattons, Hertfordshire SG14) is outside
 * London — never guessed.
 *
 * One AdapterListing per real, priced PLOT (not per development) — mirrors
 * the L&Q adapter's model (lib/adapters/lqHomes.ts): `price`/`priceValue`
 * are that plot's own real price, and `priceRange` is computed from the
 * real prices of every other priced plot this adapter actually extracted in
 * the same development (never trusting the feed's own `maxprice` field for
 * developments this adapter didn't independently verify a floor/ceiling for
 * — it happened to match live for the ones checked, but computing it from
 * data actually extracted is the same "real data derived from real data"
 * principle L&Q's adapter uses, and doesn't depend on that trust holding for
 * every development forever). A plot with no real price (`price: "---"`,
 * seen live on every `status: "Reserved"` plot) is skipped with the reason
 * logged — never inventing one.
 *
 * CRITICAL requirement — "Load more": the search-results page itself
 * paginates client-side (confirmed live: loads showing "8 of 28 results"
 * initially, a `.search-results__pagination .faux-link` labelled "Load
 * more" reveals 8 more per click, gone once everything's shown). Clicking
 * it fires ZERO additional network requests (confirmed live: the complete
 * dataset — including plots the paginated DOM view never even reaches, see
 * below — was already delivered in the one JSON response above), so the
 * primary extraction path doesn't actually depend on it. It's still driven
 * to completion every run regardless (see run()) — both because a future
 * schema change could make the JSON path fail over to the HTML-card
 * fallback below (which DOES need every card in the DOM), and to log an
 * honest click count either way, per instruction. Capped at 50 clicks with
 * growth-detection (stops early once a click adds no new cards) to avoid
 * ever spinning forever on a stuck/decorative button.
 *
 * Floor: each plot's own `floor` field is a real number, but ONLY when its
 * `showfloor` flag is true — confirmed live, house plots carry `showfloor:
 * false` with `floor` instead holding a house-type code ("Det", "SD"), not
 * a floor number, so that flag is checked rather than trusting the raw
 * value alone.
 *
 * Tenure is never stated anywhere in this JSON (checked directly: no field
 * on either the development or plot objects, and none of the London
 * developments' title/products/plot description/homeType text mentions
 * "shared ownership" either) — `detectTenure()` runs over that combined
 * text for forward-compatibility, but currently every Fairview listing's
 * tenure comes back null, never guessed from london-developers.json's
 * directory-level `tenures: ["freehold", "leasehold"]`.
 *
 * Fallback order if the JSON API's shape ever changes: (a) parse the
 * rendered HTML's own `.search-results__result` cards (confirmed live) —
 * NOTE: this site's cards render with no `href`/URL anywhere in the DOM at
 * all (plot navigation is handled by in-page JS, not a real anchor), so this
 * fallback can recover name/price/beds/location but never a real listing
 * URL — a card with no derivable URL is skipped rather than inventing one,
 * per the "never fake" rule, same as any other adapter; (b) AI extraction on
 * the rendered HTML via the same extractWithAi() the generic auto-adapter
 * uses (lib/adapters/autoAdapter.ts) — reusing it rather than duplicating.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { extractWithAi, type RawExtractedItem } from "./autoAdapter";
import { postcodeAreaIsLondon } from "./londonPostcodes";
import { detectTenure } from "./tenureDetection";
import { detectIsNewBuild } from "./newBuildDetection";
import { withBrowser } from "./browser";

const TARGET_URL = "https://www.fairview.co.uk/find-your-new-home/";
const BASE_URL = "https://www.fairview.co.uk";
const GOTO_TIMEOUT_MS = 60_000;
const RESULTS_SELECTOR_TIMEOUT_MS = 30_000;
const MAX_LOAD_MORE_CLICKS = 50;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEVELOPMENTS_JSON_RE = /\/json\/live\/developments\.json(?:$|\?)/;

const LOAD_MORE_SELECTOR =
  ".search-results__pagination .faux-link, button:has-text('Load more'), button:has-text('Show more'), " +
  "button:has-text('View more'), a:has-text('Load more'), a:has-text('Show more'), a:has-text('View more')";
const RESULT_CARD_SELECTOR = ".search-results__result";

const ANALYTICS_DOMAIN_RE =
  /google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|connect\.facebook\.net|facebook\.com\/tr|cookiebot\.com|consentcdn\.cookiebot\.com|sharethis\.com|salesforce-scrt\.com|\.my\.site\.com|hotjar\.com|clarity\.ms|criteo\.com/i;

async function blockHeavyResources(page: import("playwright-core").Page): Promise<void> {
  await page.route("**/*", (route) => {
    const request = route.request();
    const type = request.resourceType();
    if (type === "image" || type === "font") return route.abort();
    if (ANALYTICS_DOMAIN_RE.test(request.url())) return route.abort();
    return route.continue();
  });
}

// ---------- Fairview JSON feed shape (only the fields actually used) ----------

interface FairviewPlot {
  id: number;
  title?: string;
  status?: string;
  description?: string;
  homeType?: string;
  price?: string; // "£385,000", or "---" when not for sale (e.g. Reserved)
  rawprice?: number;
  bedrooms?: number;
  url?: string;
  coverimage?: string;
  // Real per-plot floor number (e.g. "2"), but ONLY meaningful when
  // `showfloor` is true — confirmed live: house plots carry `showfloor:
  // false` with `floor` instead holding a house-type abbreviation ("Det",
  // "SD"), not a floor number at all.
  floor?: string;
  showfloor?: boolean;
}

interface FairviewDevelopment {
  id: number;
  title: string;
  status?: string;
  address?: string;
  postcode?: string;
  displayaddress?: string;
  products?: string;
  coverimage?: { desktop?: { url?: string }[] };
  plots?: FairviewPlot[];
}

interface FairviewFeed {
  developments?: FairviewDevelopment[];
}

// ---------- small parsing helpers ----------

function isLondonDevelopment(dev: FairviewDevelopment): boolean {
  const postcode = (dev.postcode ?? "").trim();
  if (postcode && postcodeAreaIsLondon(postcode)) return true;
  return /\blondon\b/i.test(`${dev.address ?? ""} ${dev.displayaddress ?? ""}`);
}

/** Real area/town for a development: its own `displayaddress` (e.g. "Barnet,
 * EN4 9SH") with the postcode stripped, rather than the coarse `location`
 * field (just "London"/"Hertfordshire"/etc. — real, but far less specific
 * than what's actually published). */
function areaFor(dev: FairviewDevelopment): string {
  const display = (dev.displayaddress ?? "").trim();
  const postcode = (dev.postcode ?? "").trim();
  if (!display) return "";
  if (postcode && display.toLowerCase().includes(postcode.toLowerCase())) {
    const re = new RegExp(postcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return display.replace(re, "").replace(/,\s*$/, "").trim();
  }
  return display;
}

/** A plot only has an honest current price when BOTH its numeric `rawprice`
 * is positive AND its own display `price` string actually contains a real
 * "£" figure — checking `rawprice` alone isn't enough: confirmed live, a
 * `status: "Reserved"` plot's `price` field goes to the literal placeholder
 * "---" while `rawprice` keeps holding a stale non-zero figure (its last
 * real price before being reserved) — trusting that alone would silently
 * resurrect a price the site itself is no longer publishing. */
function parsePlotPrice(plot: FairviewPlot): number | null {
  if (typeof plot.rawprice !== "number" || plot.rawprice <= 0) return null;
  if (!plot.price || !plot.price.includes("£")) return null;
  return plot.rawprice;
}

function formatGbp(n: number): string {
  return `£${n.toLocaleString("en-GB")}`;
}

/** Real floor number for an apartment plot — null whenever `showfloor` is
 * false (house plots; `floor` there holds a house-type code, not a floor
 * number — see the FairviewPlot interface) or the value doesn't parse to a
 * number. 0 (ground floor) is a valid result, so an empty/absent string is
 * distinguished from it explicitly. */
function parsePlotFloor(plot: FairviewPlot): number | null {
  if (plot.showfloor !== true) return null;
  if (plot.floor == null || plot.floor.trim() === "") return null;
  const n = parseInt(plot.floor, 10);
  return Number.isFinite(n) ? n : null;
}

// ---------- fallback strategies (only reached if the JSON feed is empty) ----------

const PRICE_TEXT_RE = /£\s?\d[\d,]{2,}/;

/** Minimal HTML-card fallback, scoped to this site's own
 * `.search-results__result` markup (confirmed live) rather than a generic
 * heuristic — only reached if the JSON feed's shape has changed and
 * returned nothing usable. These cards carry no `href`/URL anywhere in the
 * DOM (see file header) — every item built here has `url: null` and is
 * dropped by the caller rather than inventing one. */
function extractFromRenderedCards(html: string): RawExtractedItem[] {
  const $ = cheerio.load(html);
  const items: RawExtractedItem[] = [];

  $(RESULT_CARD_SELECTOR).each((_, el) => {
    const $card = $(el);
    const text = $card.text().replace(/\s+/g, " ").trim();
    const priceMatch = text.match(PRICE_TEXT_RE);
    if (!priceMatch) return;
    const priceValue = parseFloat(priceMatch[0].replace(/[£,]/g, ""));
    if (!Number.isFinite(priceValue) || priceValue <= 0) return;

    const name =
      $card.find("h3").first().text().replace(/\s+/g, " ").trim() ||
      $card.find(".search-results__result--location span").first().text().trim();
    if (!name) return;

    const imgSrc = $card.find("img").first().attr("src") || null;
    const bedMatch = text.match(/BEDS\s*(\d+)/i);
    const postcodeMatch = text.match(/[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/i);

    items.push({
      name,
      url: null, // never present in this site's DOM — see file header
      priceValue,
      priceText: priceMatch[0].replace(/\s+/g, ""),
      bedrooms: bedMatch ? parseInt(bedMatch[1], 10) : null,
      postcode: postcodeMatch ? postcodeMatch[0].toUpperCase() : null,
      image: imgSrc ? new URL(imgSrc, BASE_URL).toString() : null,
      tenure: detectTenure(text),
      rawText: text,
    });
  });

  return items;
}

export const fairviewNewHomesAdapter: SourceAdapter = {
  id: "fairview-new-homes", // must match the id in london-developers.json exactly
  name: "Fairview New Homes",

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

      // ---- network capture: every xhr/fetch request, and the developments
      // feed's JSON body specifically ----
      const requestLog: { method: string; url: string }[] = [];
      let feedJson: FairviewFeed | null = null;

      page.on("request", (req) => {
        if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
          requestLog.push({ method: req.method(), url: req.url() });
        }
      });
      page.on("response", (res) => {
        if (DEVELOPMENTS_JSON_RE.test(res.url())) {
          res
            .json()
            .then((json) => {
              feedJson = json as FairviewFeed;
            })
            .catch(() => {});
        }
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Fairview New Homes search page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(
          `Fairview New Homes search page: unexpected HTTP ${httpStatus}`,
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }

      // Wait for a real result card, not just DOM-attached — 30s, logged
      // (not thrown) on a miss, since the JSON-capture path below doesn't
      // actually depend on the DOM having rendered them.
      let resultsAppeared = true;
      try {
        await page.waitForSelector(`${RESULT_CARD_SELECTOR}, text=/£\\s?\\d/`, {
          timeout: RESULTS_SELECTOR_TIMEOUT_MS,
        });
      } catch {
        resultsAppeared = false;
        console.warn(`[fairview-new-homes] no result card / £-price appeared within ${RESULTS_SELECTOR_TIMEOUT_MS}ms`);
      }

      // Whether the "Load more" control is really gone vs. just not painted
      // yet — the SPA's first render can occasionally lag past the 30s wait
      // above under a slow connection (confirmed live: cards/button both
      // present within ~2s on a normal run, but a single check right after
      // a timed-out wait can still race a late paint) — retried a few times
      // with a short pause rather than trusting one immediate check, so a
      // slow start is never mistaken for "no more results".
      async function loadMoreVisible(): Promise<boolean> {
        const loadMore = page.locator(LOAD_MORE_SELECTOR).first();
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await loadMore.isVisible().catch(() => false)) return true;
          if (attempt < 2) await page.waitForTimeout(1000);
        }
        return false;
      }

      // CRITICAL: click "Load more" until it's gone or stops adding cards —
      // driven to completion every run regardless of the JSON path's own
      // needs (see file header for why that's still correct/cheap to do).
      let clicks = 0;
      let lastCardCount = await page.locator(RESULT_CARD_SELECTOR).count().catch(() => 0);
      for (; clicks < MAX_LOAD_MORE_CLICKS; ) {
        if (!(await loadMoreVisible())) break;
        const loadMore = page.locator(LOAD_MORE_SELECTOR).first();

        await loadMore.click().catch(() => {});
        clicks++;
        await page.waitForTimeout(700);

        const newCardCount = await page.locator(RESULT_CARD_SELECTOR).count().catch(() => lastCardCount);
        if (newCardCount <= lastCardCount) {
          console.warn(
            `[fairview-new-homes] "Load more" click ${clicks} added no new cards (${lastCardCount} → ${newCardCount}) — stopping`
          );
          break;
        }
        lastCardCount = newCardCount;
      }
      if (clicks >= MAX_LOAD_MORE_CLICKS) {
        console.warn(`[fairview-new-homes] hit the ${MAX_LOAD_MORE_CLICKS}-click safety cap on "Load more"`);
      }

      await page.waitForTimeout(500);
      const renderedHtml = await page.content();
      const finalCardCount = await page.locator(RESULT_CARD_SELECTOR).count().catch(() => lastCardCount);

      console.warn(
        `[fairview-new-homes] ${requestLog.length} xhr/fetch request(s); developments feed ` +
          `${feedJson ? "found" : "NOT found"}` +
          (feedJson
            ? ` (${(feedJson as FairviewFeed).developments?.length ?? 0} development(s) nationwide)`
            : "") +
          `; "Load more" clicked ${clicks} time(s), ${finalCardCount} result card(s) in the DOM afterwards`
      );
      for (const r of requestLog) console.warn(`[fairview-new-homes]   ${r.method} ${r.url}`);

      let listings: AdapterListing[] = [];
      let extractionMethod = "network-json";
      let skippedNonLondon = 0;
      let skippedNoPrice = 0;

      // If the response was somehow never captured passively (race with a
      // very fast load), fetch the exact same public endpoint directly
      // through the same session before giving up on the JSON path.
      if (!feedJson) {
        try {
          const res = await page.request.get(`${BASE_URL}/json/live/developments.json`);
          requestLog.push({ method: "GET (direct)", url: res.url() });
          if (res.ok()) feedJson = (await res.json()) as FairviewFeed;
        } catch (err) {
          console.warn(
            `[fairview-new-homes] direct fetch of developments.json failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      const developments = (feedJson as FairviewFeed | null)?.developments ?? [];

      if (developments.length > 0) {
        for (const dev of developments) {
          const plots = dev.plots ?? [];
          if (plots.length === 0) continue; // e.g. "Coming Soon" — nothing to list yet, not an error

          if (!isLondonDevelopment(dev)) {
            skippedNonLondon++;
            continue;
          }

          const area = areaFor(dev);
          const postcode = (dev.postcode ?? "").toUpperCase();
          const devImage = dev.coverimage?.desktop?.[0]?.url
            ? new URL(dev.coverimage.desktop[0].url, BASE_URL).toString()
            : null;

          const built: { plot: FairviewPlot; priceValue: number; url: string }[] = [];
          for (const plot of plots) {
            const priceValue = parsePlotPrice(plot);
            if (priceValue == null) {
              skippedNoPrice++;
              continue; // e.g. Reserved plots publish "---" — never invent a price
            }
            const url = plot.url ? new URL(plot.url, BASE_URL).toString() : null;
            if (!url) continue; // no real listing URL — never invent one
            built.push({ plot, priceValue, url });
          }
          if (built.length === 0) continue;

          // priceRange from the real prices actually extracted for this
          // development — see file header for why this isn't taken from
          // the feed's own (live-confirmed-but-untrusted) `maxprice` field.
          const prices = built.map((b) => b.priceValue);
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          const priceRange = max > min ? `${formatGbp(min)} - ${formatGbp(max)}` : null;

          for (const { plot, priceValue, url } of built) {
            const image = plot.coverimage ? new URL(plot.coverimage, BASE_URL).toString() : devImage;
            listings.push({
              externalId: `fairview-${plot.id}`,
              title: `${plot.title ?? `Plot ${plot.id}`}, ${dev.title}`,
              price: plot.price ?? formatGbp(priceValue),
              priceValue,
              priceRange,
              url,
              images: image ? [image] : [],
              mainImage: image,
              bedrooms: typeof plot.bedrooms === "number" ? plot.bedrooms : null,
              bedroomType: null, // not published per room
              floor: parsePlotFloor(plot),
              tenure: detectTenure(`${dev.title} ${dev.products ?? ""} ${plot.description ?? ""} ${plot.homeType ?? ""}`),
              isNewBuild: detectIsNewBuild(`${dev.title} ${plot.description ?? ""}`).isNewBuild,
              postcode,
              area,
            });
          }
        }
      }

      // Fallback (a): parse the rendered HTML's own result cards, in case
      // the JSON feed's shape changed and returned nothing usable. Cards
      // never carry a real URL in this site's DOM (see file header), so
      // this can only ever produce listings when a `url` genuinely resolves
      // — which, as documented, it currently never does; kept for
      // forward-compatibility rather than being dead code by design.
      if (listings.length === 0) {
        const cardItems = extractFromRenderedCards(renderedHtml).filter((item) => item.url);
        const londonCardItems = cardItems.filter(
          (item) =>
            (item.postcode && postcodeAreaIsLondon(item.postcode)) || /\blondon\b/i.test(`${item.name} ${item.url}`)
        );
        if (londonCardItems.length > 0) {
          extractionMethod = "html-card-fallback";
          listings = londonCardItems.map((item, i) => ({
            externalId: `fairview-card-${i}-${new URL(item.url!).pathname.replace(/\W+/g, "-")}`,
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
            (item.postcode && postcodeAreaIsLondon(item.postcode)) || /\blondon\b/i.test(`${item.name} ${item.url}`)
        );
        if (londonAiRaw.length > 0) {
          extractionMethod = "ai_extraction";
          listings = londonAiRaw.map((item, i) => ({
            externalId: `fairview-ai-${i}-${new URL(item.url!).pathname.replace(/\W+/g, "-")}`,
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
          console.warn(`[fairview-new-homes] AI extraction fallback: ${attempted.join(", ") || "not attempted"}`);
        }
      }

      if (listings.length === 0) {
        throw new Error(
          `Fairview New Homes search page (${TARGET_URL}) returned HTTP ${httpStatus}` +
            (resultsAppeared ? "" : " and no result card/price ever appeared") +
            `. "Load more" was clicked ${clicks} time(s) (${finalCardCount} card(s) in the DOM). Network ` +
            `capture found ${developments.length} development(s) nationwide from the JSON feed ` +
            `(${skippedNonLondon} not in a London postcode, ${skippedNoPrice} plot(s) with no published ` +
            `price), but 0 produced a usable London listing after JSON parsing, the HTML-card fallback, ` +
            `and AI extraction.`
        );
      }

      console.warn(
        `[fairview-new-homes] built ${listings.length} London listing(s) via ${extractionMethod} ` +
          `(${skippedNonLondon} non-London development(s) skipped, ${skippedNoPrice} unpriced plot(s) skipped)`
      );

      return { httpStatus, listings, extractionMethod };
    } finally {
      await context.close();
    }
    });
  },
};
