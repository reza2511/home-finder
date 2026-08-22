/**
 * Real adapter for Barratt London (barratthomes.co.uk) — no mock/sample data.
 *
 * robots.txt (https://www.barratthomes.co.uk/robots.txt) was checked before
 * writing this: it disallows a handful of specific paths (`/search-results`,
 * `/new-homes/london/barratt-home`, etc.) but explicitly allows everything
 * else, including the two endpoints used here.
 *
 * NOTE on `barratthomes.co.uk/new-homes/london`: this is Barratt's own
 * marketing hub page for London. It was fetched and inspected directly (curl,
 * live) and contains zero development/plot cards and zero embedded
 * development codes in its HTML — only navigation links out to other pages.
 * There is nothing to extract from that specific URL. The two endpoints
 * below are what its own navigation and search widgets actually call to get
 * real listing data, and are still barratthomes.co.uk, still real, still
 * unauthenticated:
 *
 * Two real, public, unauthenticated sources feed this adapter:
 *
 *   1. `GET /api/search/devplots?brandCodes=bln` — a JSON endpoint (used by
 *      the site's own location-search widget) listing every current Barratt
 *      London development: name, address, price range, bedroom range, a
 *      photo, and its real detail-page URL.
 *
 *   2. Each development's own detail page (e.g.
 *      `/new-homes/dev002578-bermondsey-heights/`) server-renders an
 *      "available homes" list of individual plot cards — real plot number,
 *      a real single bedroom count, a real single price, a real photo, and
 *      a real URL to that specific home. This is what each Listing maps to.
 *
 * Individual-unit search (`/new-homes/london/search-results/`) exists but
 * calls the same development-level API — Barratt doesn't expose per-plot
 * data through any other endpoint, and no page anywhere states tenure. Both
 * gaps are left as `null`/absent rather than guessed — see `tenure` and
 * `bedroomType` below.
 *
 * Floor: some (not all — houses and some flats don't) plot cards carry a
 * real "Floor N" `<li>` inside the same `plot__features` block as the
 * bedroom count and price (confirmed live) — parsed directly, left `null`
 * when that li isn't present rather than guessed.
 */
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectIsNewBuild } from "./newBuildDetection";

const BASE_URL = "https://www.barratthomes.co.uk";
const DEVPLOTS_API_URL = `${BASE_URL}/api/search/devplots?brandCodes=bln`;
const REQUEST_TIMEOUT_MS = 12_000;
const DEV_PAGE_DELAY_MS = 350; // be a polite crawler — don't hammer 10+ pages back to back

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
  developmentStatus: string;
}

interface FetchResult {
  status: number;
  text: string;
  contentType: string | null;
}

async function fetchText(url: string, accept: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { Accept: accept },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get("content-type") };
}

/** Throws with a real body snippet attached whenever the response isn't usable
 * (bot-block/challenge page, or any non-2xx) so the failure is diagnosable
 * from the Status Monitor rather than silently swallowed. */
function assertUsableResponse(result: FetchResult, context: string): void {
  if (isBotBlockSignal(result.status, result.text)) {
    throw new AdapterHttpError(
      `${context}: response looked like a bot-block/challenge page`,
      result.status,
      result.text.slice(0, 500)
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new AdapterHttpError(`${context}: unexpected HTTP ${result.status}`, result.status, result.text.slice(0, 500));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(path: string | undefined | null): string {
  if (!path) return "";
  const cleaned = path.replace(/&amp;/g, "&");
  return cleaned.startsWith("http") ? cleaned : `${BASE_URL}${cleaned}`;
}

function extractPostcode(address: string): string {
  const match = address.match(/[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}/i);
  return match ? match[0].toUpperCase() : "";
}

// Matches each server-rendered "available home" card on a development page:
// <a href=".../plot-185-h8609185/" class="plot ">...<h3 class="plot__heading">Plot 185</h3>
// ...data-src="...w=600...">...<ul class="plot__features">...1 Bed Apartment...From £428,000...</ul>
const PLOT_CARD_RE =
  /<a href="(https:\/\/www\.barratthomes\.co\.uk\/new-homes\/[^"]*\/plot-[^"]*)" class="plot ">[\s\S]*?<h3 class="plot__heading">([^<]*)<\/h3>[\s\S]*?data-src="([^"]*)"[\s\S]*?<ul class="plot__features">([\s\S]*?)<\/ul>/g;

interface ParsedPlot {
  url: string;
  plotNumber: string;
  image: string;
  bedrooms: number;
  bedroomLabel: string;
  floor: number | null;
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
    if (!bedMatch || !priceMatch) continue; // e.g. a "Sold" card with no price shown — skip, don't guess

    const bedroomLabel = bedMatch[1].replace(/\s+/g, " ").trim();
    const bedrooms = /studio/i.test(bedroomLabel) ? 0 : parseInt(bedroomLabel, 10) || 0;
    const price = parseInt(priceMatch[1].replace(/,/g, ""), 10);
    const plotNumberMatch = heading.match(/\d+/);
    // A real "Floor N" li on this exact card (confirmed live) — only some
    // plots state it (e.g. houses/ground-floor maisonettes don't), never
    // guessed when absent.
    const floorMatch = featuresBlock.match(/\bFloor\s*(\d+)\b/i);

    plots.push({
      url,
      plotNumber: plotNumberMatch ? plotNumberMatch[0] : heading.trim(),
      image: absoluteUrl(bestImage),
      bedrooms,
      bedroomLabel,
      floor: floorMatch ? parseInt(floorMatch[1], 10) : null,
      price,
      isNewBuild: detectIsNewBuild(featuresBlock.replace(/<[^>]+>/g, " ")).isNewBuild,
    });
  }
  return plots;
}

export const barrattLondonAdapter: SourceAdapter = {
  id: "barratt-london", // must match the id in london-developers.json exactly
  name: "Barratt London",

  async run(): Promise<AdapterRunResult> {
    const apiResult = await fetchText(DEVPLOTS_API_URL, "application/json");
    assertUsableResponse(apiResult, "Barratt devplots API");

    let developments: DevplotsApiEntry[];
    try {
      const parsed = JSON.parse(apiResult.text);
      if (!Array.isArray(parsed)) throw new Error("response was not a JSON array");
      developments = parsed;
    } catch {
      throw new Error(
        `Barratt devplots API returned HTTP ${apiResult.status} with Content-Type ` +
          `"${apiResult.contentType}" but the body wasn't the expected JSON array. ` +
          `First 300 chars: ${apiResult.text.slice(0, 300)}`
      );
    }

    // "Coming soon" developments have no homes to view yet — not real listings.
    const forSale = developments.filter((d) => !d.comingSoon);
    const listings: AdapterListing[] = [];
    const pageErrors: string[] = [];

    for (const dev of forSale) {
      let devPage: FetchResult;
      try {
        devPage = await fetchText(dev.url, "text/html");
      } catch (err) {
        pageErrors.push(`${dev.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      // A block on one development page from the same session means the
      // whole source should read as blocked, not silently short a few homes.
      if (isBotBlockSignal(devPage.status, devPage.text)) {
        throw new AdapterHttpError(
          `Barratt blocked the request for "${dev.name}" (${dev.url})`,
          devPage.status,
          devPage.text.slice(0, 500)
        );
      }
      if (devPage.status < 200 || devPage.status >= 300) {
        pageErrors.push(`${dev.name}: HTTP ${devPage.status}`);
        continue;
      }

      const postcode = extractPostcode(dev.fullAdr || dev.adr || "");
      const heroImage = absoluteUrl(dev.img);

      for (const plot of parsePlots(devPage.text)) {
        const images = [plot.image, heroImage].filter(
          (src, index, arr) => !!src && arr.indexOf(src) === index
        );
        listings.push({
          externalId: `${dev.hcode}-plot-${plot.plotNumber}`,
          title: `${plot.bedroomLabel}, ${dev.name}`,
          price: `From £${plot.price.toLocaleString("en-GB")}`,
          priceValue: plot.price,
          url: plot.url,
          images,
          mainImage: images[0] ?? null,
          bedrooms: plot.bedrooms,
          bedroomType: null, // Barratt doesn't publish single/double per room
          floor: plot.floor,
          // Checked for shared ownership specifically (re-verified live):
          // several development pages have a "Home Reach" (Barratt's
          // shared-ownership scheme) jump-link in their nav, but that
          // section's actual plot content is injected client-side and isn't
          // present in the static HTML this adapter fetches (no Playwright
          // here — see file header) — no per-plot signal to key off, so
          // never guessed. Left null, same as every other tenure signal.
          tenure: null,
          isNewBuild: plot.isNewBuild,
          postcode,
          area: dev.town ?? "",
        });
      }

      await delay(DEV_PAGE_DELAY_MS);
    }

    // If developments are genuinely for sale with plots reported available,
    // but we parsed zero listings, the page markup likely changed — surface
    // that loudly instead of quietly reporting "no results".
    const expectedAvailable = forSale.filter((d) => d.availablePlotCount > 0);
    if (listings.length === 0 && expectedAvailable.length > 0) {
      throw new Error(
        `Fetched ${developments.length} Barratt London developments (${forSale.length} for sale, ` +
          `${expectedAvailable.length} reporting available plots) but parsed 0 individual plot ` +
          `listings — the site's plot-card HTML structure may have changed.` +
          (pageErrors.length > 0 ? ` Page fetch errors: ${pageErrors.join("; ")}` : "")
      );
    }

    return { httpStatus: apiResult.status, listings, extractionMethod: "custom-adapter" };
  },
};
