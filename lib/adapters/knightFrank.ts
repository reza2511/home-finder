/**
 * Dedicated adapter for Knight Frank (knightfrank.co.uk) — a general London
 * estate agent, NOT a developer's own site (source_type: "estate-agent" in
 * london-developers.json, trustAsNewBuild: true — see file footer). No
 * mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery):
 *
 *   https://www.knightfrank.co.uk/properties/residential/for-sale/uk-greater-london-london/all-types/all-beds;feature=299,300,16915;pricemax=500000
 *
 * (Knight Frank's own London search, filtered by feature ids 299/300/16915
 * — confirmed live these correspond to "New Build"/"New Development"/"New
 * Homes" — and capped at £500,000.)
 *
 * robots.txt (https://www.knightfrank.co.uk/robots.txt, checked 2026-08):
 * disallows several query-string patterns (`?*curr*`, `?*sort*`, etc.),
 * `/en-GB/`, `/en-gb/`, `/en/`, and office-space paths — none apply here.
 * This URL uses `;`-delimited path segments, not a `?` query string at all,
 * so none of the disallowed query patterns match; the path itself
 * (`/properties/residential/for-sale/...`) isn't under any disallowed
 * prefix either.
 *
 * CRITICAL — network-json feed: confirmed live by capturing this page's own
 * network traffic (Playwright response listener) — it calls a real, public
 * JSON REST API on load:
 *
 *   GET https://api-v2.web.prd-knightfrank.com/properties/search
 *       ?slug=uk-greater-london-london&features=299,300,16915
 *       &maxPrice=500000&division=Residential&type=Sales&limit=48...
 *
 * returning `{ Offset, Limit, Total, Properties: [...] }` with full,
 * real per-property data already — postcode, coordinates, price (with
 * prefix/range), bedrooms min/max, tenure, a real image URL array, and
 * enough fields to build the canonical detail-page URL directly
 * (`/properties/residential/for-sale/{Slug}/{Number}`, confirmed live
 * against the page's own anchor hrefs). No extra per-listing fetch needed
 * — extractionMethod: "network-json".
 *
 * A bare `fetch()`/curl to this API returns 401 (confirmed live) — it
 * requires whatever the page's own JS run sends (session/consent state,
 * not just a header this adapter could hardcode), so the response is
 * captured live via `page.on("response")` during the real page load rather
 * than replayed as a standalone request, same approach as this app's other
 * network-json adapters (see berkeley.ts, redrow.ts).
 *
 * CRITICAL — pagination: the API's own `Offset`/`Limit`/`Total` are used
 * directly to know when everything has been fetched (confirmed live:
 * `Total: 10`, well under one `Limit: 48` response — nothing to paginate
 * today). For a future larger result set, a real "Load More" control is
 * clicked (mirrors berkeley.ts's loadMoreButton pattern) and each
 * subsequent captured response is merged in, until `Properties` collected
 * reaches `Total`, the button disappears, or a click adds no new response
 * — safety-capped and logged either way.
 *
 * CRITICAL — London only: the "uk-greater-london-london" search slug is
 * trusted as the primary signal, but confirmed live it still lets a real
 * Home Counties town through (Weybridge, KT13, Surrey) — a real
 * postcode/text backstop (lib/adapters/londonPostcodes.ts) filters those
 * out, same approach every other aggregator-style adapter in this app
 * already applies.
 *
 * Tenure: the API's own `TenureType` field is null on every result checked
 * live — `detectTenure()` runs over `ShortDescription` + the property's own
 * `Features` tag names instead, same "real text, never guessed" rule as
 * every other adapter.
 *
 * trustAsNewBuild: true (this entry) — every property collected here is
 * kept and stored as `isNewBuild: true`, no per-listing new-build
 * signal-checking — this search is already scoped to Knight Frank's own
 * "New Build"/"New Development"/"New Homes" feature tags.
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

const SOURCE_ID = "knight-frank";
const BASE_URL = "https://www.knightfrank.co.uk";
const TARGET_URL = `${BASE_URL}/properties/residential/for-sale/uk-greater-london-london/all-types/all-beds;feature=299,300,16915;pricemax=500000`;
const API_URL_RE = /api-v2\.web\.prd-knightfrank\.com\/properties\/search/;
const GOTO_TIMEOUT_MS = 60_000;
const MAX_LOAD_MORE_CLICKS = 30; // real total confirmed live: 0 needed (Total 10 fits in one Limit-48 response)

interface KfPrice {
  PriceMinFormatted?: string;
  PriceMaxFormatted?: string;
  PricePrefix?: string | null;
  IsRange?: boolean;
}
interface KfProperty {
  Id: string;
  Address: string;
  Postcode: string | null;
  Slug: string;
  Number: string;
  Price: KfPrice;
  ImgUrls?: string[];
  ShortDescription?: string;
  TenureType?: string | null;
  BedroomsMinimum?: number | null;
  BedroomsMaximum?: number | null;
  Features?: { Name: string }[];
}
interface KfSearchResponse {
  Offset: number;
  Limit: number;
  Total: number;
  Properties: KfProperty[];
}

function parsePriceValue(price: KfPrice): number | null {
  const raw = price.PriceMinFormatted ?? price.PriceMaxFormatted;
  if (!raw) return null;
  const value = parseFloat(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function formatPriceDisplay(price: KfPrice): string {
  const base = price.PriceMinFormatted ?? "";
  return price.PricePrefix ? `${price.PricePrefix} ${base}`.trim() : base;
}

function buildPriceRange(price: KfPrice): string | null {
  if (!price.IsRange) return null;
  if (!price.PriceMinFormatted || !price.PriceMaxFormatted) return null;
  if (price.PriceMinFormatted === price.PriceMaxFormatted) return null;
  return `${price.PriceMinFormatted} - ${price.PriceMaxFormatted}`;
}

/** A single, unambiguous bedroom count — min and max must agree (a genuine
 * range with no way to attribute a specific count to this one property
 * entry is left null, never guessed). */
function singleBedroomCount(min: number | null | undefined, max: number | null | undefined): number | null {
  if (min == null || max == null) return null;
  return min === max ? min : null;
}

export const knightFrankAdapter: SourceAdapter = {
  id: SOURCE_ID, // must match the id in london-developers.json exactly
  name: "Knight Frank",

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

      const captured: KfSearchResponse[] = [];
      page.on("response", (res) => {
        if (API_URL_RE.test(res.url())) {
          res
            .json()
            .then((json) => captured.push(json as KfSearchResponse))
            .catch(() => {});
        }
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Knight Frank search page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Knight Frank search page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      // The API response is fired asynchronously by the page's own JS — give
      // it a real window to arrive rather than checking `captured` instantly.
      const deadline = Date.now() + 15_000;
      while (captured.length === 0 && Date.now() < deadline) {
        await page.waitForTimeout(300);
      }

      if (captured.length === 0) {
        throw new Error(
          `Knight Frank search page (${TARGET_URL}) returned HTTP ${httpStatus} but no ` +
            `properties/search network-json response was ever captured — the site's API may have changed.`
        );
      }

      const first = captured[0];
      console.warn(
        `[knight-frank] network-json feed found: Offset ${first.Offset}, Limit ${first.Limit}, Total ${first.Total}, ` +
          `${first.Properties?.length ?? 0} propert(y/ies) in first response`
      );

      const allProperties: KfProperty[] = [...(first.Properties ?? [])];
      let pagesVisited = 1;
      let clicks = 0;

      // CRITICAL deep pagination: keep clicking "Load More" (if present)
      // and capturing each subsequent response until every property Total
      // reports has been collected, the button disappears, or a click adds
      // nothing new — safety-capped regardless.
      while (allProperties.length < first.Total && clicks < MAX_LOAD_MORE_CLICKS) {
        const loadMore = page.getByRole("button", { name: /load more/i }).first();
        const visible = await loadMore.isVisible().catch(() => false);
        if (!visible) {
          console.warn(`[knight-frank] no visible "Load More" control (${allProperties.length}/${first.Total} collected) — stopping`);
          break;
        }
        const beforeCount = captured.length;
        await loadMore.click().catch(() => {});
        clicks++;
        pagesVisited++;

        const clickDeadline = Date.now() + 10_000;
        while (captured.length === beforeCount && Date.now() < clickDeadline) {
          await page.waitForTimeout(300);
        }
        if (captured.length === beforeCount) {
          console.warn(`[knight-frank] "Load More" click ${clicks} produced no new response — stopping`);
          break;
        }
        const next = captured[captured.length - 1];
        allProperties.push(...(next.Properties ?? []));
      }
      if (clicks >= MAX_LOAD_MORE_CLICKS) {
        console.warn(`[knight-frank] hit the ${MAX_LOAD_MORE_CLICKS}-click safety cap`);
      }
      console.warn(
        `[knight-frank] walked ${pagesVisited} response page(s) (${clicks} "Load More" click(s)), ` +
          `${allProperties.length} propert(y/ies) collected (site reported Total ${first.Total})`
      );

      const listings: AdapterListing[] = [];
      let skipped = 0;
      let skippedNonLondon = 0;
      const seenIds = new Set<string>();

      for (const prop of allProperties) {
        if (seenIds.has(prop.Id)) continue; // same property can recur across a re-sorted response boundary
        seenIds.add(prop.Id);

        const priceValue = parsePriceValue(prop.Price);
        if (priceValue == null || !prop.Address || !prop.Slug || !prop.Number) {
          skipped++;
          continue; // no honest price/name/url — never invent one
        }

        // CRITICAL — London only: the "uk-greater-london-london" search
        // slug is trusted as the primary signal, but confirmed live it
        // still lets a real Home Counties town through (Weybridge, KT13) —
        // a real postcode/text backstop (lib/adapters/londonPostcodes.ts)
        // filters those out, same approach every other aggregator-style
        // adapter in this app already applies.
        const postcode = (prop.Postcode ?? "").trim();
        const isLondon = postcodeAreaIsLondon(postcode) || /\blondon\b/i.test(prop.Address);
        if (!isLondon) {
          skippedNonLondon++;
          continue;
        }

        const textHaystack = `${prop.ShortDescription ?? ""} ${(prop.Features ?? []).map((f) => f.Name).join(" ")}`;

        listings.push({
          externalId: `knight-frank-${prop.Id}`,
          title: prop.Address,
          price: formatPriceDisplay(prop.Price) || `£${priceValue.toLocaleString("en-GB")}`,
          priceValue,
          priceRange: buildPriceRange(prop.Price),
          url: `${BASE_URL}/properties/residential/for-sale/${prop.Slug}/${prop.Number}`,
          images: prop.ImgUrls ?? [],
          mainImage: prop.ImgUrls?.[0] ?? null,
          bedrooms: singleBedroomCount(prop.BedroomsMinimum, prop.BedroomsMaximum),
          bedroomType: null, // not published per room
          tenure: detectTenure(`${prop.TenureType ?? ""} ${textHaystack}`),
          isNewBuild: true, // trustAsNewBuild — see file header
          postcode,
          area: prop.Address,
        });
      }

      console.warn(
        `[knight-frank] trustAsNewBuild: ${listings.length} kept, ${skipped} skipped for missing price/address/url, ` +
          `${skippedNonLondon} not in a London postcode/area`
      );

      if (allProperties.length === 0) {
        throw new Error(
          `Knight Frank search page (${TARGET_URL}) returned HTTP ${httpStatus} and reported Total ` +
            `${first.Total}, but collected 0 properties at all — the API's response shape may have changed.`
        );
      }

      return { httpStatus, listings, extractionMethod: "network-json" };
    } finally {
      await context.close();
    }
  },
};
