/**
 * Real adapter for Bellway London (bellway.co.uk) — no mock/sample data.
 *
 * robots.txt (https://www.bellway.co.uk/robots.txt) was checked first: it
 * disallows only `/new-homes/results*` and `/your-nest/search-results*` —
 * everything used here is allowed.
 *
 * Bellway has no single "London" hub page — it's a national housebuilder
 * organised into ~19 regional divisions (`/new-homes/{region}`), and London
 * developments are scattered across several of them, not confined to the
 * one division literally named "north-london". Confirmed live (2026-08):
 * that division is actually a wide Surrey/Essex/Hertfordshire/Buckingham-
 * shire commuter-belt area — only 3 of its 14 developments are genuinely in
 * London. This is exactly why the generic auto-adapter's URL discovery kept
 * landing on real-but-wrong-region developments (Eastern Counties,
 * Manchester) — it has no concept of Bellway's region structure.
 *
 * This adapter instead scans every region plausibly bordering or including
 * Greater London (REGIONS_TO_SCAN below — regions with no realistic chance
 * of it, e.g. Yorkshire/Durham/Scotland/Wales/Manchester/the Midlands/South
 * West/Wessex, are skipped entirely, not fetched) and decides London
 * membership from each development's own published address on its region
 * hub page, e.g. "Fielders Crescent, Barking, London, IG11 0FU" vs "Lye
 * Lane, St Albans, Hertfordshire, AL2 2DS" — real per-development address
 * text Bellway itself publishes, not a guess. Every genuine London
 * development found live explicitly said "London" or "Greater London" in
 * its address; every non-London one explicitly named a different county
 * instead (including one literally called "Westcombe Park" that turned out
 * to be in Maldon, Essex — a reminder not to trust a name, only the real
 * address) — so that's the primary signal used, more precise than a
 * postcode-area allowlist alone (which can't tell a Bexley, Greater London
 * DA postcode from a Dartford, Kent one — both share the same area
 * letters).
 *
 * Each matching development's own page then lists its real available house
 * types/plots as repeated `<article class="slick-slide">` cards — a real
 * name, a real "From £X" starting price, a real photo, and a real URL to
 * that specific home. Two real template variants were found live: house
 * developments show a plain "2 bedroom mid terrace home" description;
 * apartment developments show the bedroom count inside an icon list
 * instead. Handled by reading each card's own plain text for a bedroom
 * count rather than one fixed selector, which works for both.
 */
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter, TenureValue } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectTenure } from "./tenureDetection";

const BASE_URL = "https://www.bellway.co.uk";
const REQUEST_TIMEOUT_MS = 15_000;
const REGION_PAGE_DELAY_MS = 300;
const DEV_PAGE_DELAY_MS = 300;
const MIN_PLAUSIBLE_PROPERTY_PRICE = 50_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Regions plausibly bordering or including Greater London (confirmed live:
// genuine London developments turned up under north-london, thames-gateway,
// and southern-counties). Regions with no realistic chance of it — Durham,
// East/West Midlands, North East/West, Manchester, Scotland East/West,
// South West, Wales, Wessex, Yorkshire — are deliberately not fetched at
// all, narrowing the real work rather than guessing at membership.
const REGIONS_TO_SCAN = [
  "north-london",
  "thames-gateway",
  "southern-counties",
  "eastern-counties",
  "essex",
  "kent",
  "northern-home-counties",
  "thames-valley",
];

interface FetchResult {
  status: number;
  text: string;
}

async function fetchText(url: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function absoluteUrl(path: string): string {
  return path.startsWith("http") ? path : `${BASE_URL}${path}`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "’")
    .replace(/\s+/g, " ")
    .trim();
}

// Matches one development tile on a region hub page:
// <a href="/new-homes/{region}/{slug}"><h4 class="heading">Name</h4></a>
// <p class="description">Full address including postcode</p>
const DEV_TILE_RE =
  /<a href="(\/new-homes\/[a-z0-9-]+\/[a-z0-9-]+)">\s*<h4 class="heading">([^<]*)<\/h4>\s*<\/a>\s*<p class="description">([^<]*)<\/p>/g;

interface RegionDevelopment {
  url: string;
  name: string;
  address: string;
}

function parseRegionDevelopments(html: string): RegionDevelopment[] {
  const devs: RegionDevelopment[] = [];
  const re = new RegExp(DEV_TILE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    devs.push({ url: absoluteUrl(m[1]), name: decodeHtmlEntities(m[2]), address: decodeHtmlEntities(m[3]) });
  }
  return devs;
}

// Real, direct signal from Bellway's own address text (see file header) —
// not a postcode-area guess. Requires "London"/"Greater London" to be its
// OWN comma-separated segment of the address, not merely a substring —
// confirmed necessary live: Scholars Walk's address is "London Road,
// Bishop's Stortford, Hertfordshire, CM23 3LU" (its street is named
// "London Road"; the development itself is in Hertfordshire, not London),
// which a plain substring match wrongly accepted.
function isLondonAddress(address: string): boolean {
  return address.split(",").some((segment) => /^(greater\s+)?london$/i.test(segment.trim()));
}

function extractPostcode(address: string): string {
  const match = address.match(/[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}\s*$/i);
  return match ? match[0].trim().toUpperCase() : "";
}

function areaFromAddress(address: string, postcode: string): string {
  return postcode ? address.slice(0, address.length - postcode.length).replace(/,\s*$/, "").trim() : address;
}

// Marks each house-type/plot card on a development's own page.
const ARTICLE_START_RE = /<article class="slick-slide">/g;

interface ParsedPlot {
  url: string;
  title: string;
  price: string;
  priceValue: number;
  bedrooms: number | null;
  image: string | null;
  tenure: TenureValue | null;
}

// A genuine per-unit price card is always a single "From £X" value —
// confirmed live. A card whose "result-pricing" span held a range ("From
// £390,000 to £775,000") turned out to be a mismatched, non-plot promo
// tile reusing the same card markup elsewhere on the page (its own link
// went to a generic "buying with Bellway" page, not a plot) — rejecting
// anything that isn't the plain single-value shape catches that class of
// bogus card directly, rather than trying to enumerate every way a promo
// tile might differ.
const SINGLE_PRICE_RE = /^From\s*£[\d,]+$/i;

function parseDevelopmentPlots(html: string, devUrl: string): ParsedPlot[] {
  const starts: number[] = [];
  const startRe = new RegExp(ARTICLE_START_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(html))) starts.push(m.index);
  if (starts.length === 0) return [];
  starts.push(html.length);

  const plots: ParsedPlot[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    // Bounded per-card slice — two real page-template variants were found
    // live with different internal structure (see file header), and an
    // earlier unbounded regex crossed into a later, unrelated card's own
    // fields when a given card lacked one of them. Slicing to this card's
    // own boundary and searching only within it fixes that regardless of
    // which fields a particular card has.
    const chunk = html.slice(starts[i], starts[i + 1]);
    const hrefMatch = chunk.match(/<a class="image" href="([^"]*)"/) ?? chunk.match(/<a href="([^"]*)"/);
    const titleMatch = chunk.match(/<span class="result-title">\s*([^<]*?)\s*<\/span>/);
    const priceMatch = chunk.match(/<span class="result-pricing">\s*([^<]*?)\s*<\/span>/);
    if (!hrefMatch || !titleMatch || !priceMatch) continue; // e.g. a sold-out tile with no price shown
    if (!SINGLE_PRICE_RE.test(priceMatch[1].trim())) continue; // not a real single-plot price card

    const url = absoluteUrl(hrefMatch[1]);
    // A real plot page is always nested under its own development's path
    // (e.g. .../north-london/scholars-walk/the-bowyer-...); the bogus card
    // above linked to an unrelated top-level page instead — this catches
    // that class of mismatch directly too.
    if (!url.startsWith(devUrl)) continue;

    const priceValue = parseInt(priceMatch[1].replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(priceValue) || priceValue < MIN_PLAUSIBLE_PROPERTY_PRICE) continue;

    const imgMatch = chunk.match(/<img src="([^"]*)"/);
    // Read from the chunk's own plain text rather than one fixed selector —
    // works for both real template variants (see file header).
    const text = chunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const isStudio = /\bstudio\b/i.test(text);
    const bedMatch = text.match(/(\d+)\s*bed(?:room)?s?\b/i);

    plots.push({
      url,
      title: decodeHtmlEntities(titleMatch[1]),
      price: decodeHtmlEntities(priceMatch[1]),
      priceValue,
      bedrooms: isStudio ? 0 : bedMatch ? parseInt(bedMatch[1], 10) : null,
      image: imgMatch ? absoluteUrl(imgMatch[1]) : null,
      tenure: detectTenure(text),
    });
  }
  return plots;
}

function makeExternalId(plotUrl: string): string {
  try {
    const slug = new URL(plotUrl).pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
    return slug || plotUrl;
  } catch {
    return plotUrl;
  }
}

export const bellwayLondonAdapter: SourceAdapter = {
  id: "bellway-london", // must match the id in london-developers.json exactly
  name: "Bellway London",

  async run(): Promise<AdapterRunResult> {
    let lastHttpStatus = 200;
    const allDevs: RegionDevelopment[] = [];
    const regionErrors: string[] = [];

    for (const region of REGIONS_TO_SCAN) {
      let result: FetchResult;
      try {
        result = await fetchText(`${BASE_URL}/new-homes/${region}`);
      } catch (err) {
        regionErrors.push(`${region}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      assertUsableResponse(result, `Bellway /new-homes/${region}`);
      lastHttpStatus = result.status;
      allDevs.push(...parseRegionDevelopments(result.text));
      await delay(REGION_PAGE_DELAY_MS);
    }

    if (allDevs.length === 0) {
      throw new Error(
        `Fetched ${REGIONS_TO_SCAN.length} Bellway region page(s) (${REGIONS_TO_SCAN.join(", ")}) but found 0 ` +
          `development tiles — the region hub page's HTML structure may have changed.` +
          (regionErrors.length > 0 ? ` Region fetch errors: ${regionErrors.join("; ")}` : "")
      );
    }

    // Dedupe by URL — a development could in principle be cross-listed
    // under more than one region page.
    const seenUrls = new Set<string>();
    const londonDevs = allDevs.filter((d) => {
      if (!isLondonAddress(d.address)) return false;
      if (seenUrls.has(d.url)) return false;
      seenUrls.add(d.url);
      return true;
    });

    const listings: AdapterListing[] = [];
    const devErrors: string[] = [...regionErrors];

    for (const dev of londonDevs) {
      let page: FetchResult;
      try {
        page = await fetchText(dev.url);
      } catch (err) {
        devErrors.push(`${dev.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (isBotBlockSignal(page.status, page.text)) {
        throw new AdapterHttpError(
          `Bellway blocked the request for "${dev.name}" (${dev.url})`,
          page.status,
          page.text.slice(0, 500)
        );
      }
      if (page.status < 200 || page.status >= 300) {
        devErrors.push(`${dev.name}: HTTP ${page.status}`);
        continue;
      }
      lastHttpStatus = page.status;

      const postcode = extractPostcode(dev.address);
      const area = areaFromAddress(dev.address, postcode);

      for (const plot of parseDevelopmentPlots(page.text, dev.url)) {
        listings.push({
          externalId: makeExternalId(plot.url),
          title: `${plot.title}, ${dev.name}`,
          price: plot.price,
          priceValue: plot.priceValue,
          priceRange: null,
          url: plot.url,
          images: plot.image ? [plot.image] : [],
          mainImage: plot.image,
          bedrooms: plot.bedrooms,
          bedroomType: null, // not published per room
          tenure: plot.tenure,
          isNewBuild: true,
          postcode,
          area,
        });
      }

      await delay(DEV_PAGE_DELAY_MS);
    }

    if (listings.length === 0) {
      throw new Error(
        `Found ${londonDevs.length} London Bellway development(s) across ${REGIONS_TO_SCAN.length} scanned ` +
          `region(s) but parsed 0 available plot listings — either genuinely none currently available right ` +
          `now (some developments legitimately show "Coming soon", e.g. Tavistock Quarter), or the plot-card ` +
          `HTML structure changed.` +
          (devErrors.length > 0 ? ` Page fetch errors: ${devErrors.join("; ")}` : "")
      );
    }

    return { httpStatus: lastHttpStatus, listings, extractionMethod: "custom-adapter" };
  },
};
