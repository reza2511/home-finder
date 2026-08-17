/**
 * Real adapter for Taylor Wimpey London (taylorwimpey.co.uk) — no mock data.
 *
 * robots.txt (https://www.taylorwimpey.co.uk/robots.txt) was checked first:
 * it disallows a handful of paths (`/area/`, `/digital-showroom/`, etc.) but
 * explicitly allows everything else, including `/new-homes/london` used here.
 *
 * Unlike Barratt London, Taylor Wimpey's `/new-homes/london` hub page itself
 * server-renders real plot cards for every current London development in one
 * response (a Vue "home finder" widget, SSR'd) — real development name, a
 * real single price, a real single bedroom count, a real photo, and a real
 * URL to that specific home. So this adapter needs only one request, not one
 * per development.
 *
 * Two things confirmed and handled:
 *
 *  - The raw HTML repeats each plot card once per client-side sort mode
 *    (`showPlot('price-low')` / `showPlot('price-high')`), so naive
 *    extraction double-counts — plots are de-duplicated by their real URL.
 *  - This hub page shows a capped preview per development (seen: up to 6),
 *    not that development's full inventory. That's a real limitation of
 *    what this one page publishes, not a parsing bug — noted here rather
 *    than papered over.
 *
 * Not published anywhere in the fetched HTML (checked directly): postcodes
 * (only a full street address, e.g. "12 Mount Pleasant, London" — used as
 * `area`) and tenure (a "shared ownership" price-card variant exists, but
 * that's a different sales scheme, not the same concept as our
 * freehold/leasehold/share-of-freehold `tenure` field, so it is not mapped
 * onto it). Both are left absent rather than guessed.
 */
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";

const BASE_URL = "https://www.taylorwimpey.co.uk";
const LISTINGS_URL = `${BASE_URL}/new-homes/london`;
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchText(url: string): Promise<{ status: number; text: string; contentType: string | null }> {
  const res = await fetch(url, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get("content-type") };
}

function absoluteUrl(path: string | undefined | null): string {
  if (!path) return "";
  const cleaned = path.replace(/&amp;/g, "&");
  if (cleaned.startsWith("http")) return cleaned;
  return `${BASE_URL}${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
}

// Plot titles/addresses come from raw HTML text nodes (unlike Barratt's,
// which come from clean JSON), so entities need decoding for display.
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

// Matches one development block: <div class="hf-dev-segment" data-property-id="...">
const DEV_BLOCK_START_RE = /<div class="hf-dev-segment" data-property-id="[^"]*"/g;

const DEV_HEADING_RE = /<h2>\s*<a href="([^"]*)">([^<]*)<\/a>/;
const DEV_ADDRESS_RE = /hf-dev-segment-content__location--address">([^<]*)</;

// Matches one plot card within a development's chunk of HTML.
const PLOT_CARD_RE =
  /<div class="home-finder-plot-segment__content-detail--left">[\s\S]*?data-src="([^"]*)"[\s\S]*?<h3>&#163;([\d,]+)<\/h3>[\s\S]*?<h4 class="home-finder-plot-segment__title">\s*<a href="([^"]*)">\s*([^<]*?)\s*<\/a>[\s\S]*?aria-label="number of bedrooms is ([^"]*)"/g;

interface ParsedPlot {
  url: string;
  title: string;
  image: string;
  bedrooms: number;
  price: number;
}

function parseBedrooms(raw: string): number | null {
  if (/studio/i.test(raw)) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parsePlotsForDevelopment(chunk: string): ParsedPlot[] {
  const plots: ParsedPlot[] = [];
  const seenUrls = new Set<string>();
  const re = new RegExp(PLOT_CARD_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunk))) {
    const [, dataSrc, priceRaw, href, title, bedroomsRaw] = match;
    const url = absoluteUrl(href);
    if (seenUrls.has(url)) continue; // same plot repeated for another sort mode
    const bedrooms = parseBedrooms(bedroomsRaw);
    const price = parseInt(priceRaw.replace(/,/g, ""), 10);
    if (bedrooms === null || !Number.isFinite(price)) continue;

    seenUrls.add(url);
    plots.push({
      url,
      title: decodeHtmlEntities(title.replace(/\s+/g, " ").trim()),
      image: absoluteUrl(dataSrc),
      bedrooms,
      price,
    });
  }
  return plots;
}

export const taylorWimpeyLondonAdapter: SourceAdapter = {
  id: "taylor-wimpey-london", // must match the id in london-developers.json exactly
  name: "Taylor Wimpey London",

  async run(): Promise<AdapterRunResult> {
    const result = await fetchText(LISTINGS_URL);

    if (isBotBlockSignal(result.status, result.text)) {
      throw new AdapterHttpError(
        "Taylor Wimpey London listings page: response looked like a bot-block/challenge page",
        result.status,
        result.text.slice(0, 500)
      );
    }
    if (result.status < 200 || result.status >= 300) {
      throw new AdapterHttpError(
        `Taylor Wimpey London listings page: unexpected HTTP ${result.status}`,
        result.status,
        result.text.slice(0, 500)
      );
    }

    const starts: number[] = [];
    const startRe = new RegExp(DEV_BLOCK_START_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = startRe.exec(result.text))) starts.push(m.index);

    if (starts.length === 0) {
      throw new Error(
        `Taylor Wimpey London listings page returned HTTP ${result.status} with Content-Type ` +
          `"${result.contentType}" but contained no development blocks — the page's HTML structure ` +
          `may have changed. First 300 chars: ${result.text.slice(0, 300)}`
      );
    }
    starts.push(result.text.length);

    const listings: AdapterListing[] = [];

    for (let i = 0; i < starts.length - 1; i++) {
      const chunk = result.text.slice(starts[i], starts[i + 1]);
      const headingMatch = chunk.match(DEV_HEADING_RE);
      if (!headingMatch) continue; // no name/url for this block — skip rather than guess one

      const developmentName = decodeHtmlEntities(headingMatch[2].trim());
      const developmentUrl = absoluteUrl(headingMatch[1]);
      const addressMatch = chunk.match(DEV_ADDRESS_RE);
      const area = addressMatch ? decodeHtmlEntities(addressMatch[1].trim()) : "";

      for (const plot of parsePlotsForDevelopment(chunk)) {
        listings.push({
          externalId: plot.url.replace(BASE_URL, "").replace(/^\/+|\/+$/g, ""),
          title: `${plot.title}, ${developmentName}`,
          price: `£${plot.price.toLocaleString("en-GB")}`,
          priceValue: plot.price,
          url: plot.url || developmentUrl,
          images: plot.image ? [plot.image] : [],
          mainImage: plot.image || null,
          bedrooms: plot.bedrooms,
          bedroomType: null, // not published per room
          tenure: null, // not published anywhere on taylorwimpey.co.uk
          isNewBuild: true,
          postcode: "", // not published on this page — never guessed
          area,
        });
      }
    }

    if (listings.length === 0) {
      throw new Error(
        `Taylor Wimpey London listings page returned HTTP ${result.status} and ${starts.length - 1} ` +
          `development block(s), but parsed 0 individual plot listings — the page's plot-card HTML ` +
          `structure may have changed.`
      );
    }

    return { httpStatus: result.status, listings, extractionMethod: "custom-adapter" };
  },
};
