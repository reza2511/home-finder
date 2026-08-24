/**
 * Real adapter for Ballymore (ballymoregroup.com) — no mock/sample data.
 *
 * robots.txt (https://www.ballymoregroup.com/robots.txt) was checked first:
 * `Disallow:` is empty for `User-agent: *` — everything is allowed.
 *
 * The homepage itself is pure marketing and lists no developments. The real
 * listings page is https://www.ballymoregroup.com/project — a Nuxt-rendered
 * grid of every current Ballymore development (`.block-projects__view-item`
 * cards), each linking to that development's own page on ballymoregroup.com
 * (`/project/<slug>`). Confirmed live (2026-08): 11 cards total — 5 in
 * London, 6 in Ireland (Wicklow/Westmeath/Kildare/Dublin). Ballymore also
 * runs a Dublin office alongside its London one, so the overseas projects
 * are real current stock, not noise — `isUkListing()` below filters them out
 * since this app is UK/London-only.
 *
 * Neither the listings page nor any individual project page renders behind
 * a JS data-fetch that needs waiting for — both are server-rendered HTML, so
 * Playwright is used here for reliable resource-blocking and a real
 * price-selector wait, not because the content is client-fetched.
 *
 * No card on the listings page shows a price (confirmed: 0/11 contain "£"),
 * so every UK project's own page is fetched to get one. On that page, price
 * appears in prose, not a structured field, e.g. "Prices from £538,000." or
 * "...homes from £445,000." — always a single "from" floor, never a stated
 * upper bound, so `priceRange` is left null rather than invented. One London
 * project (25 Cuba, confirmed live 2026-08) publishes no price anywhere on
 * ballymoregroup.com at all — its real per-unit pricing lives only on its
 * own separate microsite (25cuba.com), which is a different domain outside
 * this adapter's scope. That project is skipped with a logged reason rather
 * than guessing a price.
 *
 * No full UK postcode appears anywhere on either page (checked directly) —
 * only the outward/district code as part of the location line, e.g.
 * "25 Cuba St, Docklands, London E14". That outward code is what
 * `extractOutwardCode()` captures as `postcode`; a full postcode is never
 * fabricated to fill the gap.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectIsNewBuild } from "./newBuildDetection";
import { withBrowser } from "./browser";

const BASE_URL = "https://www.ballymoregroup.com";
const LISTINGS_URL = `${BASE_URL}/project`;
const GOTO_TIMEOUT_MS = 60_000;
const SELECTOR_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Analytics/consent/tracking domains seen on this site (GTM, Google
// Analytics, the Cookiebot consent widget, Meta pixel) — aborted so they
// don't hold connections open or slow down a text-only extraction pass.
const ANALYTICS_DOMAIN_RE =
  /googletagmanager\.com|google-analytics\.com|doubleclick\.net|googlesyndication\.com|connect\.facebook\.net|facebook\.com\/tr|cookiebot\.com|consentcdn\.cookiebot\.com|hotjar\.com|clarity\.ms/i;

async function blockHeavyResources(page: import("playwright-core").Page): Promise<void> {
  await page.route("**/*", (route) => {
    const request = route.request();
    const type = request.resourceType();
    if (type === "image" || type === "font") return route.abort();
    if (ANALYTICS_DOMAIN_RE.test(request.url())) return route.abort();
    return route.continue();
  });
}

/** Waits for a project card (listings page) or a £-price element (project
 * page) to appear, 30s timeout. Waits for DOM attachment rather than visual
 * visibility: extraction reads page.content() (raw DOM), not the rendered
 * layout, and these cards sit in a container whose height/visibility is set
 * by a mapbox script that may not have run yet under `domcontentloaded` —
 * "attached" is what extraction actually depends on. A miss is logged, not
 * thrown — the page may genuinely have neither (e.g. a project with no
 * published price), and the subsequent HTML parse is what actually decides
 * whether anything usable came back. */
async function waitForCardOrPrice(
  page: import("playwright-core").Page,
  selector: string,
  context: string
): Promise<void> {
  try {
    await page.waitForSelector(selector, { state: "attached", timeout: SELECTOR_TIMEOUT_MS });
  } catch {
    console.warn(
      `[ballymore] "${selector}" did not appear on ${context} within ${SELECTOR_TIMEOUT_MS}ms`
    );
  }
}

async function loadPage(
  page: import("playwright-core").Page,
  url: string,
  selector: string
): Promise<{ status: number; html: string }> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  await waitForCardOrPrice(page, selector, url);
  const html = await page.content();
  return { status: response?.status() ?? 0, html };
}

function absoluteUrl(href: string): string {
  if (href.startsWith("http")) return href;
  return `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
}

interface ListingCard {
  slug: string;
  url: string;
  name: string;
  location: string;
  image: string | null;
}

function parseListingCards(html: string): ListingCard[] {
  const $ = cheerio.load(html);
  const cards: ListingCard[] = [];

  $(".block-projects__view-item").each((_, el) => {
    const anchor = $(el).find("a[href^='/project/']").first();
    const href = anchor.attr("href");
    if (!href) return; // no link — nothing to build a listing from

    const name = anchor.find(".app-media-tile__heading").first().text().trim();
    const location = anchor.find(".app-media-tile__description").first().text().trim();
    const image = anchor.find("img").first().attr("src") ?? null;
    const slug = href.replace(/^\/project\//, "").replace(/\/+$/, "");

    if (!name || !slug) return; // no real name/id — skip rather than guess one
    cards.push({ slug, url: absoluteUrl(href), name, location, image });
  });

  return cards;
}

// Ballymore runs both a London and a Dublin office; the listings page mixes
// UK and Ireland developments with no explicit country field, only the
// location line. Every UK development seen (2026-08) names "London"
// explicitly; every Ireland one names "Ireland" and/or an Irish county
// ("Co. Kildare", "County Wicklow", "County Dublin"). Both signals are
// checked (not just one) so a development matching neither is excluded by
// default rather than assumed UK.
const IRELAND_SIGNAL_RE = /\bireland\b|\bco\.\s|\bcounty\s/i;
const LONDON_SIGNAL_RE = /\blondon\b/i;

function isUkListing(location: string): boolean {
  if (IRELAND_SIGNAL_RE.test(location)) return false;
  return LONDON_SIGNAL_RE.test(location);
}

// Captures the outward/district code at the end of a location line, e.g.
// "...Docklands, London E14" -> "E14", "...Nine Elms, London SW11" -> "SW11".
// This is genuinely all that's published (no full postcode appears anywhere
// on the site) — never extended into a fabricated full postcode.
const OUTWARD_CODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*$/;

function extractOutwardCode(location: string): string {
  const match = location.match(OUTWARD_CODE_RE);
  return match ? match[1].toUpperCase() : "";
}

// Matches the one place a starting price is stated in a project's prose,
// e.g. "Prices from £538,000." / "...homes from £445,000." Falls back to
// the first bare £-amount if "from" isn't present, since the wording isn't
// perfectly consistent across every project page.
const FROM_PRICE_RE = /from\s*£\s?([\d,]+)/i;
const BARE_PRICE_RE = /£\s?([\d,]+)/;

function extractStartingPrice(bodyText: string): { priceValue: number; priceText: string } | null {
  const match = bodyText.match(FROM_PRICE_RE) ?? bodyText.match(BARE_PRICE_RE);
  if (!match) return null;
  const priceValue = parseInt(match[1].replace(/,/g, ""), 10);
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  return { priceValue, priceText: `From £${priceValue.toLocaleString("en-GB")}` };
}

function extractBodyText(html: string): string {
  const $ = cheerio.load(html);
  // Cookiebot's consent dialog contains its own boilerplate "£"-free but
  // huge text block; not a price source, just stripped for cleanliness.
  $("#CybotCookiebotDialog, [id*='Cybot']").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

export const ballymoreAdapter: SourceAdapter = {
  id: "ballymore", // must match the id in london-developers.json exactly
  name: "Ballymore",

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
      const listPage = await context.newPage();
      let listResult: { status: number; html: string };
      try {
        await blockHeavyResources(listPage);
        listResult = await loadPage(listPage, LISTINGS_URL, ".block-projects__view-item");
      } finally {
        await listPage.close();
      }

      if (isBotBlockSignal(listResult.status, listResult.html)) {
        throw new AdapterHttpError(
          "Ballymore /project listings page: response looked like a bot-block/challenge page",
          listResult.status,
          listResult.html.slice(0, 500)
        );
      }
      if (listResult.status < 200 || listResult.status >= 300) {
        throw new AdapterHttpError(
          `Ballymore /project listings page: unexpected HTTP ${listResult.status}`,
          listResult.status,
          listResult.html.slice(0, 500)
        );
      }

      const allCards = parseListingCards(listResult.html);
      if (allCards.length === 0) {
        throw new Error(
          `Ballymore /project listings page returned HTTP ${listResult.status} but contained no ` +
            `project cards (".block-projects__view-item") — the page's HTML structure may have changed.`
        );
      }

      const ukCards = allCards.filter((c) => isUkListing(c.location));
      if (ukCards.length === 0) {
        // Genuinely zero UK developments right now — real result, not a
        // failure. Logged so it's diagnosable from the Status Monitor.
        console.warn(
          `[ballymore] found ${allCards.length} project(s), all filtered out as non-UK ` +
            `(locations: ${allCards.map((c) => c.location).join("; ")})`
        );
        return { httpStatus: listResult.status, listings: [], extractionMethod: "custom-adapter" };
      }

      // Small, bounded set (UK Ballymore developments, seen: 5) — fetched
      // concurrently rather than sequentially to stay well inside the sync
      // engine's per-adapter timeout even if several pages take the full
      // 60s goto + 30s selector wait.
      const skipped: string[] = [];
      const detailResults = await Promise.all(
        ukCards.map(async (card) => {
          const page = await context.newPage();
          try {
            await blockHeavyResources(page);
            const detail = await loadPage(page, card.url, "text=/£\\s?\\d/");
            return { card, detail };
          } catch (err) {
            skipped.push(`${card.name}: ${err instanceof Error ? err.message : String(err)}`);
            return { card, detail: null };
          } finally {
            await page.close();
          }
        })
      );

      const listings: AdapterListing[] = [];

      for (const { card, detail } of detailResults) {
        if (!detail) continue; // fetch/nav error for this one project — already logged in `skipped`

        if (isBotBlockSignal(detail.status, detail.html)) {
          throw new AdapterHttpError(
            `Ballymore blocked the request for "${card.name}" (${card.url})`,
            detail.status,
            detail.html.slice(0, 500)
          );
        }
        if (detail.status < 200 || detail.status >= 300) {
          skipped.push(`${card.name}: HTTP ${detail.status}`);
          continue;
        }

        const bodyText = extractBodyText(detail.html);
        const priced = extractStartingPrice(bodyText);
        if (!priced) {
          // Confirmed real gap, not a parse failure: e.g. 25 Cuba publishes
          // no price anywhere on ballymoregroup.com — its pricing lives only
          // on its own separate microsite, outside this adapter's scope.
          // Never fabricated — skipped and logged instead.
          skipped.push(`${card.name}: no price published on ${card.url}`);
          continue;
        }

        const postcode = extractOutwardCode(card.location);
        const images = card.image ? [card.image] : [];

        listings.push({
          externalId: card.slug,
          title: card.name,
          price: priced.priceText,
          priceValue: priced.priceValue,
          priceRange: null, // only a "from" floor is ever published — no stated upper bound
          url: card.url,
          images,
          mainImage: images[0] ?? null,
          bedrooms: null, // published only as a range across the whole development, never a single count
          bedroomType: null,
          // Checked for shared ownership specifically (re-verified live):
          // Riverscape's own page mentions "Shared Ownership" once, but only
          // describing a sub-set of the development's 769 homes ("207
          // affordable apartments at East River Wharf offering Shared
          // Ownership, affordable rent and social rent") — this listing's
          // one row is the general market-sale starting price, which is not
          // that shared-ownership price, so tagging it shared_ownership
          // would misrepresent what the price actually is. Left null, same
          // as every other tenure signal on this site (not published).
          tenure: null,
          // Checked against the development's own page body text (real
          // signal, not assumed) — defaults true regardless since Ballymore
          // is a new-build-only developer, same as every source here.
          isNewBuild: detectIsNewBuild(`${card.name} ${bodyText}`).isNewBuild,
          postcode,
          area: card.location,
        });
      }

      if (listings.length === 0) {
        throw new Error(
          `Fetched ${allCards.length} Ballymore project(s) (${ukCards.length} in the UK) but ` +
            `parsed 0 usable listings.` +
            (skipped.length > 0 ? ` Reasons: ${skipped.join("; ")}` : "")
        );
      }

      if (skipped.length > 0) {
        console.warn(`[ballymore] skipped ${skipped.length} UK project(s): ${skipped.join("; ")}`);
      }

      return { httpStatus: listResult.status, listings, extractionMethod: "custom-adapter" };
    } finally {
      await context.close();
    }
    });
  },
};
