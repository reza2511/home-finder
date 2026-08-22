/**
 * Dedicated adapter for Redrow (redrow.co.uk) — no mock/sample data.
 *
 * Per explicit instruction: uses ONLY this exact URL, always, and never
 * substitutes or discovers another one (no URL-discovery, unlike the
 * generic auto-adapter — see createAutoAdapter in autoAdapter.ts):
 *
 *   https://www.redrow.co.uk/locations/london/
 *
 * robots.txt (https://www.redrow.co.uk/robots.txt) was checked first: it
 * disallows `/search`, `/*?location=*`, and `/*&p=1*`, plus a handful of
 * specific brand-home paths — none of which match anything this adapter
 * fetches (the devplots API path below is `/api/search/devplots`, a
 * distinct path from the disallowed `/search`, with only a `brandCodes=`
 * query param, never `location=`).
 *
 * Confirmed live (2026-08) by capturing this page's own network traffic:
 * loading /locations/london/ fires
 *
 *   GET /api/search/devplots?brandCodes=red
 *
 * — the identical endpoint (same shape, same platform) Barratt London's own
 * adapter uses at `?brandCodes=bln` (lib/adapters/barrattLondon.ts):
 * Barratt and Redrow are now the same corporate group (Barratt Redrow) and
 * clearly share a site platform. Unlike Barratt's brand code, `red` is NOT
 * London-scoped — confirmed live: 103 developments nationwide, only 4 with
 * a genuine London postcode. `isLondonAddress()` filters using the same
 * postcode-area logic as the other dedicated adapters
 * (lib/adapters/londonPostcodes.ts).
 *
 * The API response's own per-development `properties` array looks at first
 * like it might already contain real plot-level data, but confirmed live:
 * it's populated for some "Coming Soon" developments (house-type templates
 * with `minPrice`/`maxPrice` both `0` — no real price at all) and EMPTY for
 * genuinely on-sale developments (e.g. Colindale Gardens, 8 real available
 * plots, `properties: []`) — not usable. Real plot data instead comes from
 * each development's own page (e.g.
 * `/new-homes/devr442231-colindale-gardens-colindale/`), which server-
 * renders real plot cards in the exact same markup Barratt's adapter
 * already parses (`class="plot "`, `plot__heading`, `plot__features` with
 * "N Bed Apartment" / "From £X" text) — confirmed live, byte-identical
 * structure, so the same parsing approach is reused here rather than
 * duplicated from scratch.
 *
 * Tenure is never stated anywhere on either the API response or a
 * development page (checked directly, same as Barratt) — left `null`
 * rather than guessed. bedroomType (single/double per room) isn't
 * published either — also left `null`.
 */
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { postcodeAreaIsLondon } from "./londonPostcodes";
import { detectIsNewBuild } from "./newBuildDetection";
import { getSharedBrowser } from "./browser";

const TARGET_URL = "https://www.redrow.co.uk/locations/london/";
const BASE_URL = "https://www.redrow.co.uk";
const DEVPLOTS_ENDPOINT_RE = /\/api\/search\/devplots\?brandCodes=red/;
const GOTO_TIMEOUT_MS = 60_000;
const DEV_PAGE_DELAY_MS = 350; // be a polite crawler — don't hammer several pages back to back

interface DevplotsApiEntry {
  fullAdr: string;
  adr: string;
  town: string | null;
  hcode: string;
  img: string;
  name: string;
  url: string;
  comingSoon: boolean;
  availablePlotCount: number;
}

function absoluteUrl(path: string | undefined | null): string {
  if (!path) return "";
  const cleaned = path.replace(/&amp;/g, "&");
  return cleaned.startsWith("http") ? cleaned : `${BASE_URL}${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
}

function extractPostcode(address: string): string {
  const match = address.match(/[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}/i);
  return match ? match[0].toUpperCase() : "";
}

function isLondonAddress(address: string): boolean {
  const postcode = extractPostcode(address);
  if (postcode && postcodeAreaIsLondon(postcode)) return true;
  return /\blondon\b/i.test(address);
}

// Same markup Barratt London's own adapter parses (lib/adapters/
// barrattLondon.ts) — confirmed live byte-identical on this shared platform:
// <a href=".../plot-xxx/" class="plot ">...<h3 class="plot__heading">W4 06 03</h3>
// ...data-src="...w=10...">...<ul class="plot__features">...1 Bed Apartment...From £398,000...</ul>
const PLOT_CARD_RE =
  /<a href="(https:\/\/www\.redrow\.co\.uk\/new-homes\/[^"]*)" class="plot ">[\s\S]*?<h3 class="plot__heading"[^>]*>([^<]*)<\/h3>[\s\S]*?data-src="([^"]*)"[\s\S]*?<ul class="plot__features">([\s\S]*?)<\/ul>/g;

interface ParsedPlot {
  url: string;
  plotLabel: string;
  image: string;
  bedrooms: number;
  bedroomLabel: string;
  price: number;
  isNewBuild: boolean;
}

function parsePlots(html: string): ParsedPlot[] {
  const plots: ParsedPlot[] = [];
  const re = new RegExp(PLOT_CARD_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const [, url, heading, dataSrc, featuresBlock] = match;
    const bestImage = dataSrc.split("|").pop()?.trim().split(/\s+/)[0] ?? "";
    const bedMatch = featuresBlock.match(/(Studio|\d+\s*bed[^<]*)/i);
    const priceMatch = featuresBlock.match(/From\s*&#163;\s*([\d,]+)/i);
    if (!bedMatch || !priceMatch) continue; // e.g. a "Reserved"/"Sold" card with no price shown — skip, don't guess

    const bedroomLabel = bedMatch[1].replace(/\s+/g, " ").trim();
    const bedrooms = /studio/i.test(bedroomLabel) ? 0 : parseInt(bedroomLabel, 10) || 0;
    const price = parseInt(priceMatch[1].replace(/,/g, ""), 10);

    plots.push({
      url,
      plotLabel: heading.trim(),
      image: absoluteUrl(bestImage),
      bedrooms,
      bedroomLabel,
      price,
      isNewBuild: detectIsNewBuild(featuresBlock.replace(/<[^>]+>/g, " ")).isNewBuild,
    });
  }
  return plots;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const redrowAdapter: SourceAdapter = {
  id: "redrow", // must match the id in london-developers.json exactly
  name: "Redrow",

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

      const requestLog: { method: string; url: string }[] = [];
      let devplotsJson: DevplotsApiEntry[] | null = null;

      page.on("request", (req) => {
        if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
          requestLog.push({ method: req.method(), url: req.url() });
        }
      });
      page.on("response", (res) => {
        if (DEVPLOTS_ENDPOINT_RE.test(res.url())) {
          res
            .json()
            .then((json) => {
              if (Array.isArray(json)) devplotsJson = json as DevplotsApiEntry[];
            })
            .catch(() => {});
        }
      });

      const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response?.status() ?? 0;
      const initialHtml = await page.content();

      if (isBotBlockSignal(httpStatus, initialHtml)) {
        throw new AdapterHttpError(
          "Redrow London search page: response looked like a bot-block/challenge page",
          httpStatus,
          initialHtml.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Redrow London search page: unexpected HTTP ${httpStatus}`, httpStatus, initialHtml.slice(0, 500));
      }

      await page.waitForTimeout(1500);

      // If the response was somehow never captured passively, fetch the
      // exact same public endpoint directly through the same session.
      if (!devplotsJson) {
        try {
          const res = await page.request.get(`${BASE_URL}/api/search/devplots?brandCodes=red`);
          requestLog.push({ method: "GET (direct)", url: res.url() });
          if (res.ok()) {
            const json = await res.json();
            if (Array.isArray(json)) devplotsJson = json as DevplotsApiEntry[];
          }
        } catch (err) {
          console.warn(`[redrow] direct fetch of devplots API failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.warn(
        `[redrow] ${requestLog.length} xhr/fetch request(s); devplots API ` +
          `${devplotsJson ? "found" : "NOT found"}` +
          (devplotsJson ? ` (${(devplotsJson as DevplotsApiEntry[]).length} development(s) nationwide)` : "")
      );
      for (const r of requestLog) console.warn(`[redrow]   ${r.method} ${r.url}`);

      const developments = (devplotsJson as DevplotsApiEntry[] | null) ?? [];
      const londonDevs = developments.filter((d) => isLondonAddress(d.fullAdr || d.adr || ""));
      const forSale = londonDevs.filter((d) => !d.comingSoon);

      const listings: AdapterListing[] = [];
      const pageErrors: string[] = [];

      for (const dev of forSale) {
        let devHtml: string;
        try {
          const devRes = await page.request.get(dev.url);
          if (isBotBlockSignal(devRes.status(), await devRes.text())) {
            throw new AdapterHttpError(`Redrow blocked the request for "${dev.name}" (${dev.url})`, devRes.status());
          }
          devHtml = await devRes.text();
        } catch (err) {
          if (err instanceof AdapterHttpError) throw err;
          pageErrors.push(`${dev.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        const postcode = extractPostcode(dev.fullAdr || dev.adr || "");
        const heroImage = absoluteUrl(dev.img);

        for (const plot of parsePlots(devHtml)) {
          const images = [plot.image, heroImage].filter((src, i, arr) => !!src && arr.indexOf(src) === i);
          listings.push({
            externalId: `${dev.hcode}-plot-${plot.plotLabel.replace(/\s+/g, "-").toLowerCase()}`,
            title: `${plot.bedroomLabel}, ${dev.name}`,
            price: `From £${plot.price.toLocaleString("en-GB")}`,
            priceValue: plot.price,
            url: plot.url,
            images,
            mainImage: images[0] ?? null,
            bedrooms: plot.bedrooms,
            bedroomType: null, // not published per room
            tenure: null, // not published anywhere on this site
            isNewBuild: plot.isNewBuild,
            postcode,
            area: dev.town ?? "",
          });
        }

        await delay(DEV_PAGE_DELAY_MS);
      }

      const expectedAvailable = forSale.filter((d) => d.availablePlotCount > 0);
      if (listings.length === 0 && expectedAvailable.length > 0) {
        throw new Error(
          `Redrow devplots API returned ${developments.length} development(s) nationwide (${londonDevs.length} ` +
            `London, ${forSale.length} for sale, ${expectedAvailable.length} reporting available plots), but ` +
            `parsed 0 individual plot listings — the site's plot-card HTML structure may have changed.` +
            (pageErrors.length > 0 ? ` Page fetch errors: ${pageErrors.join("; ")}` : "")
        );
      }

      console.warn(
        `[redrow] built ${listings.length} London listing(s) from ${forSale.length} for-sale development(s) ` +
          `(${londonDevs.length - forSale.length} coming-soon London development(s) skipped)`
      );

      return { httpStatus, listings, extractionMethod: "network-json" };
    } finally {
      await context.close();
    }
  },
};
