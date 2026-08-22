/**
 * Dedicated adapter for Vistry / Countryside Partnerships (countrysidehomes.com)
 * — no mock/sample data.
 *
 * The URL explicitly requested for this source —
 * https://www.countrysidehomes.com/search-results?location=london — is a
 * client-rendered search page whose own robots.txt
 * (https://www.countrysidehomes.com/robots.txt) still disallows it and its
 * backing AJAX endpoint: `Disallow: /*?` blanket-disallows every query-string
 * URL on this domain, confirmed live 2026-08 (same finding as this file's
 * previous iteration, which is why `vistry-countryside` was left unwired
 * rather than pointed at that URL — see git history / prior notes on the
 * london-developers.json entry).
 *
 * Instead — found while checking that page's own sitemap
 * (https://www.countrysidehomes.com/sitemap2.xml) — this adapter uses a
 * real, public, unauthenticated data feed the site itself publishes:
 *
 *   https://www.countrysidehomes.com/data/developments/csv
 *
 * This is NOT disallowed by robots.txt (no query string, doesn't match any
 * of `/holding`, `/admin`, `/utilities`, `/deployment`, `/enhance-extras`,
 * `/developments/joint-venture-developments`, `/developments/key-worker-
 * package`, `/schemes/key-worker`, or any path containing "/files/"). Confirmed live: a real CSV
 * (`home_listing_id,name,image[0..4].url,url,description,price,num_beds,
 * availability,Address.addr1,Address.city,Address.region,Address.country,
 * Address.postal_code`) covering all 42 of the brand's current for-sale
 * developments nationwide — one row per development (its lead-priced plot),
 * not one row per individual home.
 *
 * London filtering uses the site's OWN classification, not just a postcode
 * heuristic: every development's `url` is `/developments/{region-slug}/...`,
 * and the site itself files 6 of the 42 developments under the
 * `london` region slug — confirmed live, and confirmed MORE precise than a
 * bare postcode-area check here: two further developments (South Oxhey
 * Central, WD19 — Hertfordshire; Ashmere, Ebbsfleet Garden City, DA10 —
 * Kent) fall inside this app's LONDON_POSTCODE_AREAS set (lib/adapters/
 * londonPostcodes.ts intentionally includes the outer-London-straddling WD/
 * DA letters) but the site itself files them under `hertfordshire`/`kent`,
 * not `london` — trusting the site's own editorial region over the coarser
 * postcode-letter heuristic avoids two false positives here.
 *
 * `description` is empty on every current row (checked directly) — tenure is
 * never stated anywhere in this feed, so `tenure` stays null rather than
 * guessed for every listing (this developer's own shared-ownership stock,
 * where it exists, evidently isn't represented in this particular feed).
 *
 * Fetched via `page.request.get()`, not `page.goto()` — confirmed live: the
 * server sends this CSV with headers that make Chromium treat it as a file
 * download, so `page.goto()` throws immediately ("Download is starting")
 * before ever returning a response. `page.request.get()` is still a real
 * request made through this same Playwright-managed browser context, it
 * just isn't a browser-tab navigation, so it isn't subject to that download
 * interception — the right tool for a raw data feed rather than a page.
 */
import { AdapterHttpError, AdapterListing, AdapterRunResult, SourceAdapter } from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { detectTenure } from "./tenureDetection";
import { detectIsNewBuild } from "./newBuildDetection";
import { getSharedBrowser } from "./browser";

const CSV_URL = "https://www.countrysidehomes.com/data/developments/csv";
const GOTO_TIMEOUT_MS = 60_000;
const LONDON_REGION_SLUG_RE = /\/developments\/london\//i;

interface CsvRow {
  home_listing_id: string;
  name: string;
  "image[0].url": string;
  "image[1].url": string;
  "image[2].url": string;
  "image[3].url": string;
  "image[4].url": string;
  url: string;
  description: string;
  price: string;
  num_beds: string;
  availability: string;
  "Address.addr1": string;
  "Address.city": string;
  "Address.region": string;
  "Address.country": string;
  "Address.postal_code": string;
}

/** Minimal RFC4180-style CSV parser (quoted fields, "" escaping, CRLF/LF) —
 * no dependency needed for a feed this small (42 rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip — paired \n handles the row break
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function toRows(csvText: string): CsvRow[] {
  const table = parseCsv(csvText);
  if (table.length === 0) return [];
  const header = table[0];
  return table.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((key, i) => {
      obj[key] = cells[i] ?? "";
    });
    return obj as unknown as CsvRow;
  });
}

function parsePriceValue(priceField: string): number | null {
  const match = priceField.match(/[\d,]+/);
  if (!match) return null;
  const value = parseFloat(match[0].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const countrysideAdapter: SourceAdapter = {
  id: "vistry-countryside", // must match the id in london-developers.json exactly
  name: "Vistry / Countryside Partnerships",

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
      // NOT page.goto() — confirmed live: this endpoint serves the CSV with
      // headers that make Chromium treat it as a file download, so
      // page.goto() throws immediately ("Download is starting") before ever
      // returning a response. page.request.get() is still a real request
      // made through this same Playwright-managed browser context (same
      // cookies/headers), it just isn't a browser-tab navigation, so it
      // isn't subject to Chromium's download interception — this is the
      // correct tool for fetching a raw data feed rather than a page.
      const page = await context.newPage();
      const requestLog: { method: string; url: string }[] = [{ method: "GET", url: CSV_URL }];

      const response = await page.request.get(CSV_URL, { timeout: GOTO_TIMEOUT_MS });
      const httpStatus = response.status();
      const csvText = await response.text();

      if (isBotBlockSignal(httpStatus, csvText)) {
        throw new AdapterHttpError(
          "Countryside developments CSV feed: response looked like a bot-block/challenge page",
          httpStatus,
          csvText.slice(0, 500)
        );
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new AdapterHttpError(`Countryside developments CSV feed: unexpected HTTP ${httpStatus}`, httpStatus, csvText.slice(0, 500));
      }

      console.warn(`[countryside] ${requestLog.length} request(s) logged fetching the CSV feed; body length ${csvText.length}`);
      for (const r of requestLog) console.warn(`[countryside]   ${r.method} ${r.url}`);

      const rows = toRows(csvText);
      const londonRows = rows.filter((r) => LONDON_REGION_SLUG_RE.test(r.url || ""));

      console.warn(
        `[countryside] parsed ${rows.length} development row(s) nationwide, ${londonRows.length} filed under ` +
          `the site's own "london" region`
      );

      const listings: AdapterListing[] = [];
      let skippedNoPrice = 0;

      for (const row of londonRows) {
        const priceValue = parsePriceValue(row.price);
        if (priceValue == null || !row.url || !row.name) {
          skippedNoPrice++;
          continue; // no honest price/url/name — never invent one
        }

        const bedrooms = /^\d+$/.test((row.num_beds || "").trim()) ? parseInt(row.num_beds, 10) : null;
        const images = [
          row["image[0].url"],
          row["image[1].url"],
          row["image[2].url"],
          row["image[3].url"],
          row["image[4].url"],
        ].filter((src): src is string => !!src && src.trim() !== "");

        listings.push({
          externalId: `countryside-${row.home_listing_id || row.url}`,
          title: row.name.trim(),
          price: `From £${priceValue.toLocaleString("en-GB")}`,
          priceValue,
          priceRange: null, // feed publishes one lead price per development, never a range
          url: row.url.trim(),
          images,
          mainImage: images[0] ?? null,
          bedrooms,
          bedroomType: null, // not published per room
          tenure: detectTenure(row.description), // always null today — see file header
          isNewBuild: detectIsNewBuild(`${row.name} ${row.description}`).isNewBuild,
          postcode: (row["Address.postal_code"] || "").trim(),
          area: (row["Address.city"] || "").trim(),
        });
      }

      if (listings.length === 0) {
        throw new Error(
          `Countryside developments CSV feed (${CSV_URL}) returned HTTP ${httpStatus}, parsed ${rows.length} ` +
            `row(s) nationwide, ${londonRows.length} under the "london" region slug, but 0 produced a usable ` +
            `listing${skippedNoPrice > 0 ? ` (${skippedNoPrice} skipped for missing price/url/name)` : ""}.`
        );
      }

      console.warn(`[countryside] built ${listings.length} London listing(s) via network-json (CSV feed)`);

      return { httpStatus, listings, extractionMethod: "network-json" };
    } finally {
      await context.close();
    }
  },
};
