/**
 * Dedicated adapter for Peabody New Homes (peabodynewhomes.co.uk) — no
 * mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery, unlike the
 * generic auto-adapter — see createAutoAdapter in autoAdapter.ts):
 *
 *   https://www.peabodynewhomes.co.uk/find-a-home
 *
 * robots.txt (https://www.peabodynewhomes.co.uk/robots.txt) was checked
 * first: only `/app_plugins/` and `/umbraco/` are disallowed — this page,
 * its pagination URLs, and every listing page it links to are all allowed.
 *
 * Confirmed live (2026-08) by capturing this page's own network traffic:
 * every xhr/fetch request it fires (Cloudflare's bot-challenge beacon,
 * analytics, an affordability-calculator endpoint used only on individual
 * development pages) was checked, and NONE of them is a listings JSON
 * feed/API — results are plain server-rendered HTML
 * (`.related-item.__development` cards inside `.listing-items`), so this
 * adapter's real "preferred method" is parsing that HTML directly rather
 * than a network-json capture (which the CRITICAL pagination-walk below
 * still gets run for and logged honestly either way, per instruction, in
 * case a future site change ever introduces one — see the empty
 * `feedListings` check in run()).
 *
 * CRITICAL requirement — pagination: the list is server-side paginated via
 * a real query-string param, `?...&page=N` (confirmed live: exactly 15
 * pages, 12 cards each except a final partial page of 10 — 178 cards
 * total). Each page is a genuine full navigation (clicking "Next" is a real
 * `<a href>`, not an XHR/pushState update — confirmed live: 0 additional
 * xhr/fetch requests fire on click), so every page is walked by actually
 * clicking the real `Next` control (`a.paging-item.__next`) and waiting for
 * the resulting navigation, rather than reconstructing the URL by hand —
 * more robust to the param ever changing. The control is simply absent (no
 * `__next` link at all) on the last page, which is what ends the walk;
 * capped at 30 pages regardless as a safety net.
 *
 * The list mixes TWO real kinds of card with the same markup: most are one
 * row per DEVELOPMENT with a real published price RANGE (e.g. Lombard
 * Square: "£330,000 - £470,000"), a few are one row per individual PLOT
 * already sold as its own listing (e.g. "Oleander House - First Floor":
 * single price "£325,000", one specific home) — both are handled the same
 * way here: `price`/`priceValue` = the card's own starting (or only)
 * figure, `priceRange` = the full published range text when a second
 * figure is actually stated, else null (never invented). `bedrooms` is
 * parsed from the card's own description text (e.g. "1-bedroom apartment")
 * ONLY when it states a single, unambiguous bedroom count — a development
 * card describing multiple sizes (e.g. "1, 2 & 3-bedroom apartments") has
 * no way to honestly attribute one specific count to its starting price
 * without per-plot data this list page doesn't publish, so bedrooms is left
 * null there rather than guessed.
 *
 * Tenure: every card carries an explicit, structured tag — "Shared
 * Ownership" and/or "Private sale" (confirmed live: no other tag values
 * exist) — read directly via `detectTenure()` over the tag text plus the
 * description (shared-ownership always wins outright over any other
 * mention, per that function's own priority order — exactly the "classify
 * as shared_ownership, not leasehold" behaviour this task asked for). A
 * "Private sale"-only card has no structural tenure stated by the tag
 * itself (that's a sales method, not a legal tenure) — `detectTenure` falls
 * through to null there unless the description happens to say "leasehold"/
 * "freehold" outright, same as any other adapter's "never guessed" rule.
 * Peabody is also listed in `SHARED_OWNERSHIP_PROVIDER_IDS`
 * (lib/adapters/tenureDetection.ts) as this app's own directory says its
 * only two schemes are shared-ownership/private-sale — the sync engine's
 * post-adapter pass (`applySharedOwnershipOverride`) already tips any
 * listing this adapter genuinely leaves tenure-null over to
 * `shared_ownership`, so that default doesn't need duplicating here.
 *
 * A card with no published price at all (confirmed live: 2 of 178, both
 * future/"coming soon" phases with a description but no price/share info)
 * is skipped with the reason logged — never inventing one. `isLondonHome()`
 * filters using the same postcode-area logic as the other dedicated
 * adapters (lib/adapters/londonPostcodes.ts) — confirmed live: 34 of 178
 * cards are genuinely outside London (Buckinghamshire, Bedfordshire).
 *
 * Fallback (only reached if this markup changes and 0 usable listings come
 * out of every page): AI extraction on page 1's rendered HTML via the same
 * extractWithAi() the generic auto-adapter uses
 * (lib/adapters/autoAdapter.ts) — reusing it rather than duplicating it.
 * This last resort only ever sees page 1, not the full 15-page walk — a
 * markup change big enough to break the primary parser needs a real fix
 * here, not an AI reading one page as a permanent substitute.
 */
import * as cheerio from "cheerio";
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { extractWithAi } from "./autoAdapter";
import { postcodeAreaIsLondon, UK_POSTCODE_RE } from "./londonPostcodes";
import { detectTenure } from "./tenureDetection";
import { detectIsNewBuild } from "./newBuildDetection";
import { withBrowser } from "./browser";

const TARGET_URL = "https://www.peabodynewhomes.co.uk/find-a-home";
const BASE_URL = "https://www.peabodynewhomes.co.uk";
const GOTO_TIMEOUT_MS = 60_000;
const RESULTS_SELECTOR_TIMEOUT_MS = 30_000;
const NEXT_PAGE_TIMEOUT_MS = 15_000;
const MAX_PAGES = 30;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CARD_SELECTOR = ".related-item.__development";
const NEXT_SELECTOR = "a.paging-item.__next";

const ANALYTICS_DOMAIN_RE =
  /google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|connect\.facebook\.net|facebook\.com\/tr|clarity\.ms|hotjar\.com|criteo\.com|matterport\.com|cdn-cgi\/challenge-platform/i;

async function blockHeavyResources(page: import("playwright-core").Page): Promise<void> {
  await page.route("**/*", (route) => {
    const request = route.request();
    const type = request.resourceType();
    if (type === "image" || type === "font") return route.abort();
    if (ANALYTICS_DOMAIN_RE.test(request.url())) return route.abort();
    return route.continue();
  });
}

// ---------- card parsing ----------

interface ParsedCard {
  name: string;
  location: string;
  description: string;
  tags: string[];
  priceText: string | null; // the card's own "Price" info-list value, verbatim
  href: string | null;
  image: string | null;
}

function parseCards(html: string): ParsedCard[] {
  const $ = cheerio.load(html);
  const cards: ParsedCard[] = [];

  $(CARD_SELECTOR).each((_, el) => {
    const $card = $(el);
    const name = $card.find(".related-item-title").first().text().trim();
    const location = $card.find(".related-item-location").first().text().replace(/\s+/g, " ").trim();
    const description = $card.find(".related-item-description").first().text().replace(/\s+/g, " ").trim();

    const tags: string[] = [];
    $card.find(".related-item-tag").each((_, t) => {
      const text = $(t).text().trim();
      if (text) tags.push(text);
    });

    let priceText: string | null = null;
    $card.find(".related-item-info li").each((_, li) => {
      const title = $(li).find(".related-item-info-title").text().trim();
      if (/^price$/i.test(title)) {
        priceText = $(li).find("span").not(".related-item-info-title").first().text().trim() || null;
      }
    });

    const href = $card.find("a.item-link").attr("href") ?? null;
    const image = $card.find("img").first().attr("src") ?? null;

    if (name) cards.push({ name, location, description, tags, priceText, href, image });
  });

  return cards;
}

// ---------- small parsing helpers ----------

const PRICE_FIGURE_RE = /£\s?[\d,]+/g;

/** Parses a card's own "Price" text into a starting figure plus (only when
 * a real second figure is actually published) the full range. Returns null
 * when there's no honest £ figure at all — never inventing one. */
function parsePrice(raw: string | null): { priceValue: number; price: string; priceRange: string | null } | null {
  const figures = raw?.match(PRICE_FIGURE_RE);
  if (!figures || figures.length === 0) return null;
  const priceValue = parseFloat(figures[0].replace(/[£,\s]/g, ""));
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  return {
    priceValue,
    price: figures[0].replace(/\s+/g, ""),
    priceRange: figures.length >= 2 ? raw!.trim() : null,
  };
}

/** Postcode is always the final comma-separated segment of Peabody's own
 * `location` text (e.g. "Greenwich , London, SE28 0FA") — validated against
 * a real UK postcode pattern rather than blindly trusted, so a location
 * string that doesn't end in one (never seen live, but not guaranteed)
 * comes back with an empty postcode rather than a wrong value. */
function locationParts(location: string): { postcode: string; area: string } {
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { postcode: "", area: "" };
  const last = parts[parts.length - 1];
  if (UK_POSTCODE_RE.test(last)) {
    return { postcode: last.toUpperCase(), area: parts.slice(0, -1).join(", ") };
  }
  return { postcode: "", area: location };
}

function isLondonHome(location: string): boolean {
  const { postcode } = locationParts(location);
  if (postcode && postcodeAreaIsLondon(postcode)) return true;
  return /\blondon\b/i.test(location);
}

/** A single, unambiguous bedroom count from the card's own description —
 * e.g. "1-bedroom apartment" → 1. Returns null when the description states
 * more than one distinct size (e.g. "1, 2 & 3-bedroom apartments") since
 * there's no honest way to attribute one specific count to this card's
 * starting price without per-plot data this list page doesn't publish —
 * never guessed. */
function singleBedroomCount(description: string): number | null {
  const matches = [...description.matchAll(/(\d+)\s*-?\s*bed(?:room)?s?\b/gi)].map((m) => parseInt(m[1], 10));
  const distinct = [...new Set(matches)];
  return distinct.length === 1 ? distinct[0] : null;
}

export const peabodyNewHomesAdapter: SourceAdapter = {
  id: "peabody-new-homes", // must match the id in london-developers.json exactly
  name: "Peabody New Homes",

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

      // ---- network capture: every xhr/fetch request across every page
      // this run visits, and any JSON response body in case a listings feed
      // ever appears (none found live — see file header) ----
      const requestLog: { method: string; url: string }[] = [];
      const jsonResponseUrls: string[] = [];

      page.on("request", (req) => {
        if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
          requestLog.push({ method: req.method(), url: req.url() });
        }
      });
      page.on("response", (res) => {
        const ct = res.headers()["content-type"] ?? "";
        if (ct.includes("application/json")) jsonResponseUrls.push(res.url());
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Peabody New Homes search page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(
          `Peabody New Homes search page: unexpected HTTP ${httpStatus}`,
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }

      let resultsAppeared = true;
      try {
        await page.waitForSelector(`${CARD_SELECTOR}, text=/£\\s?\\d/`, { timeout: RESULTS_SELECTOR_TIMEOUT_MS });
      } catch {
        resultsAppeared = false;
        console.warn(`[peabody-new-homes] no result card / £-price appeared within ${RESULTS_SELECTOR_TIMEOUT_MS}ms`);
      }

      // CRITICAL: walk every page by actually clicking the real "Next"
      // control and waiting for the resulting navigation — see file header
      // for why that's more robust here than reconstructing the URL.
      const allCards: ParsedCard[] = parseCards(await page.content());
      let pagesVisited = 1;

      for (; pagesVisited < MAX_PAGES; ) {
        const nextLink = page.locator(NEXT_SELECTOR).first();
        const hasNext = (await nextLink.count().catch(() => 0)) > 0 && (await nextLink.isVisible().catch(() => false));
        if (!hasNext) break;

        const navigated = await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS }).then(
            () => true,
            () => false
          ),
          nextLink.click().catch(() => {}),
        ]).then(([ok]) => ok);
        if (!navigated) {
          console.warn(`[peabody-new-homes] "Next" click after page ${pagesVisited} didn't navigate — stopping`);
          break;
        }
        pagesVisited++;

        try {
          await page.waitForSelector(CARD_SELECTOR, { timeout: NEXT_PAGE_TIMEOUT_MS });
        } catch {
          console.warn(`[peabody-new-homes] no result card appeared on page ${pagesVisited} within ${NEXT_PAGE_TIMEOUT_MS}ms`);
        }

        const pageCards = parseCards(await page.content());
        if (pageCards.length === 0) {
          console.warn(`[peabody-new-homes] page ${pagesVisited} had 0 cards — stopping`);
          break;
        }
        allCards.push(...pageCards);
      }
      if (pagesVisited >= MAX_PAGES) {
        console.warn(`[peabody-new-homes] hit the ${MAX_PAGES}-page safety cap`);
      }

      console.warn(
        `[peabody-new-homes] ${requestLog.length} xhr/fetch request(s); ${jsonResponseUrls.length} JSON ` +
          `response(s) seen, none of them a listings feed (server-rendered HTML pagination instead — see ` +
          `file header); visited ${pagesVisited} page(s), ${allCards.length} card(s) collected in total`
      );
      for (const r of requestLog) console.warn(`[peabody-new-homes]   ${r.method} ${r.url}`);

      let listings: AdapterListing[] = [];
      const extractionMethod = "html-pagination";
      let skippedNonLondon = 0;
      let skippedNoPrice = 0;

      for (const card of allCards) {
        if (!isLondonHome(card.location)) {
          skippedNonLondon++;
          continue;
        }
        const parsedPrice = parsePrice(card.priceText);
        if (!parsedPrice) {
          skippedNoPrice++;
          console.warn(`[peabody-new-homes] skipping "${card.name}" — no published price`);
          continue;
        }
        if (!card.href) continue; // no real listing URL — never invent one

        const url = new URL(card.href, BASE_URL).toString();
        const image = card.image ? new URL(card.image, BASE_URL).toString() : null;
        const { postcode, area } = locationParts(card.location);
        const tenure = detectTenure(`${card.tags.join(" ")} ${card.description}`);

        // Known, honestly-reported gap: a "Private sale"-only card (real
        // signal Peabody itself publishes — this is NOT shared ownership)
        // has no leasehold/freehold text on this list page either, so
        // `tenure` genuinely comes back null here — and Peabody being in
        // SHARED_OWNERSHIP_PROVIDER_IDS (tenureDetection.ts) means the
        // sync engine's cross-adapter override will then tip it to
        // `shared_ownership` anyway, same as a listing this adapter never
        // saw any signal for at all. That override predates this adapter
        // and is a deliberate, documented tradeoff for known
        // shared-ownership-heavy providers — flagged here rather than
        // silently accepted, since it's a real (if rare) misclassification
        // this adapter can see coming but can't prevent without inventing
        // a leasehold/freehold split this source never actually states.
        if (tenure === null && card.tags.includes("Private sale") && !card.tags.includes("Shared Ownership")) {
          console.warn(
            `[peabody-new-homes] "${card.name}" is tagged "Private sale" (not shared ownership) but states no ` +
              `leasehold/freehold split — will be relabelled shared_ownership by the cross-adapter default for ` +
              `known shared-ownership providers (see SHARED_OWNERSHIP_PROVIDER_IDS in tenureDetection.ts)`
          );
        }

        listings.push({
          externalId: `peabody-${new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-")}`,
          title: card.name,
          price: parsedPrice.price,
          priceValue: parsedPrice.priceValue,
          priceRange: parsedPrice.priceRange,
          url,
          images: image ? [image] : [],
          mainImage: image,
          bedrooms: singleBedroomCount(card.description),
          bedroomType: null, // not published per room
          tenure,
          isNewBuild: detectIsNewBuild(`${card.name} ${card.tags.join(" ")} ${card.description}`).isNewBuild,
          postcode,
          area,
        });
      }

      // Fallback: AI extraction on page 1's rendered HTML only — last
      // resort, reusing the generic auto-adapter's implementation rather
      // than duplicating it (see file header for why this doesn't attempt
      // the full pagination walk itself).
      if (listings.length === 0) {
        const attempted: string[] = [];
        const aiRaw = await extractWithAi(initialHtml, BASE_URL, attempted);
        const londonAiRaw = aiRaw.filter(
          (item) =>
            (item.postcode && postcodeAreaIsLondon(item.postcode)) || /\blondon\b/i.test(`${item.name} ${item.url}`)
        );
        if (londonAiRaw.length > 0) {
          for (let i = 0; i < londonAiRaw.length; i++) {
            const item = londonAiRaw[i];
            if (!item.url) continue;
            listings.push({
              externalId: `peabody-ai-${i}-${new URL(item.url).pathname.replace(/\W+/g, "-")}`,
              title: item.name!,
              price: item.priceText ?? `£${item.priceValue!.toLocaleString("en-GB")}`,
              priceValue: item.priceValue!,
              priceRange: null,
              url: item.url,
              images: item.image ? [item.image] : [],
              mainImage: item.image,
              bedrooms: item.bedrooms,
              bedroomType: null,
              tenure: item.tenure,
              isNewBuild: detectIsNewBuild(item.rawText).isNewBuild,
              postcode: item.postcode ?? "",
              area: "",
            });
          }
        } else {
          console.warn(`[peabody-new-homes] AI extraction fallback: ${attempted.join(", ") || "not attempted"}`);
        }
      }

      if (listings.length === 0) {
        throw new Error(
          `Peabody New Homes search page (${TARGET_URL}) returned HTTP ${httpStatus}` +
            (resultsAppeared ? "" : " and no result card/price ever appeared") +
            `. Walked ${pagesVisited} page(s) and collected ${allCards.length} card(s) total ` +
            `(${skippedNonLondon} not in a London postcode, ${skippedNoPrice} with no published price), but 0 ` +
            `produced a usable London listing after HTML parsing and AI extraction.`
        );
      }

      console.warn(
        `[peabody-new-homes] built ${listings.length} London listing(s) via ${extractionMethod} ` +
          `(${skippedNonLondon} non-London card(s) skipped, ${skippedNoPrice} unpriced card(s) skipped)`
      );

      return { httpStatus, listings, extractionMethod };
    } finally {
      await context.close();
    }
    });
  },
};
