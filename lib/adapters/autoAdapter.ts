/**
 * Generic auto-adapter: attempts to extract real listings from any
 * developer's `listings_url` with no site-specific code. Used for every
 * developer in london-developers.json that doesn't have a hand-built adapter
 * (lib/adapters/barrattLondon.ts, lib/adapters/taylorWimpeyLondon.ts).
 *
 * Pipeline:
 *   1. Fetch the page. Detect a bot-block (→ AdapterHttpError, classified
 *      `blocked`) the same way the custom adapters do.
 *   2. If the static HTML looks like a near-empty JS-app shell, render it
 *      with Playwright before parsing.
 *   3. Try, in order, the first strategy that yields at least one usable
 *      listing: (a) JSON-LD / schema.org, (b) an embedded JSON blob
 *      (Next.js __NEXT_DATA__, Nuxt/generic window state objects), (c) a
 *      generic HTML heuristic — repeated "card" elements containing a
 *      £-price, read for nearby bedroom/postcode/tenure text.
 *   4. Normalise into AdapterListing. A raw hit only becomes a listing if it
 *      has a real name, a real URL, and a real parsed price — those three
 *      anchor whether something is a usable listing at all. bedrooms,
 *      postcode, image, and tenure are left `null`/absent whenever genuinely
 *      not found — never guessed or defaulted.
 *
 * If nothing works, throws AdapterAutoExtractionError with one of
 * `js_required` / `no_pattern_found` / `parse_error` and the list of
 * strategies actually tried — the sync engine records this as a real
 * `error` row (never `not_built`, since this always genuinely attempts
 * extraction) with that reason and attempt list in `errorMessage`.
 */
import * as cheerio from "cheerio";
import type { DeveloperEntry } from "../developers";
import { updateListingsUrlInFile } from "../developers";
import { supabase } from "../db";
import {
  AdapterAutoExtractionError,
  AdapterHttpError,
  AdapterListing,
  AdapterRunResult,
  SourceAdapter,
  TenureValue,
} from "./types";
import { isBotBlockSignal } from "./blockDetection";
import { discoverCandidateUrls } from "./urlDiscovery";
import { postcodeAreaIsLondon } from "./londonPostcodes";
import { detectTenure, isExclusivelySharedOwnershipProvider } from "./tenureDetection";

const FETCH_TIMEOUT_MS = 15_000;
// domcontentloaded rather than load/networkidle: many sites never go fully
// idle (polling widgets, chat scripts, ad pixels), which was the direct
// cause of the "page.goto: Timeout 20000ms exceeded" failures — the actual
// listing content readiness is checked separately below, not by waiting for
// network silence.
const GOTO_TIMEOUT_MS = 60_000;
const PRICE_SELECTOR_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// A realistic set of headers a real Chrome browser would send — beyond just
// the User-Agent — since some bot-detection triggers on a too-minimal
// header set alone.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

interface FetchResult {
  status: number;
  text: string;
  contentType: string | null;
}

async function fetchText(url: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get("content-type") };
}

function randomDelayMs(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(path: string, baseUrl: string): string {
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

function parsePriceNumber(text: string): number | null {
  const match = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

// ---------- JS-render detection ----------

/** A near-empty static shell (typical of a client-rendered SPA) has almost
 * no visible text and/or an empty framework root mount point. */
function looksJsRendered(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const textOnly = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasEmptyRootMount = /<div id="(root|app|__next|__nuxt|__nuxt-app)"[^>]*>\s*<\/div>/i.test(bodyHtml);
  return textOnly.length < 600 || hasEmptyRootMount;
}

// ---------- Playwright rendering (lazy-loaded, concurrency-limited) ----------

const MAX_CONCURRENT_RENDERS = 6;

declare global {
  // eslint-disable-next-line no-var
  var __autoAdapterActiveRenders: number | undefined;
  // eslint-disable-next-line no-var
  var __autoAdapterRenderQueue: (() => void)[] | undefined;
}
globalThis.__autoAdapterActiveRenders ??= 0;
globalThis.__autoAdapterRenderQueue ??= [];

function acquireRenderSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      globalThis.__autoAdapterActiveRenders!++;
      resolve(() => {
        globalThis.__autoAdapterActiveRenders!--;
        const next = globalThis.__autoAdapterRenderQueue!.shift();
        if (next) next();
      });
    };
    if (globalThis.__autoAdapterActiveRenders! < MAX_CONCURRENT_RENDERS) grant();
    else globalThis.__autoAdapterRenderQueue!.push(grant);
  });
}

// Stored on globalThis (same pattern as lib/db.ts's connection singleton) so
// that a Next.js dev-server hot-reload re-evaluating this module reuses the
// existing browser process instead of orphaning it — a plain module-level
// `let` here previously leaked a new Chromium process on every edit to this
// file, and ~20 of them piling up starved every subsequent render into
// timing out.
declare global {
  // eslint-disable-next-line no-var
  var __autoAdapterBrowser: Promise<import("playwright").Browser> | undefined;
}

function getBrowser(): Promise<import("playwright").Browser> {
  if (!globalThis.__autoAdapterBrowser) {
    globalThis.__autoAdapterBrowser = import("playwright").then(({ chromium }) =>
      // --disable-blink-features=AutomationControlled removes the most
      // obvious automation tell (navigator.webdriver); this is "look like a
      // normal browser", not fingerprint-spoofing or CAPTCHA-solving.
      chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })
    );
  }
  return globalThis.__autoAdapterBrowser;
}

// Resource types that never affect extraction (we only ever read text/DOM/
// JSON) but cost real load time — aborting them speeds up every render and
// removes a common source of goto hangs on media-heavy pages.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media"]);

// Known analytics/tracking/ad domains — aborted regardless of resource type,
// since these often hold a connection open (beacons, long-poll) which can
// stall "networkidle"-style waits and just adds noise to a text-extraction
// pass that never looks at them.
// Matched against the full request URL (not just hostname), so no anchor —
// these are distinctive enough strings that false positives on unrelated
// content-serving domains are effectively impossible.
const TRACKING_DOMAIN_RE =
  /google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|connect\.facebook\.net|facebook\.com\/tr|hotjar\.com|segment\.(io|com)|mixpanel\.com|fullstory\.com|clarity\.ms|hs-(scripts|analytics)\.com|hsforms\.(com|net)|intercom\.io|drift\.com|optimizely\.com|criteo\.com|adroll\.com|taboola\.com|outbrain\.com|cloudflareinsights\.com|newrelic\.com|nr-data\.net|datadoghq\.com|amazon-adsystem\.com|adnxs\.com|bat\.bing\.com|analytics\.tiktok\.com|sc-static\.net|pinterest\.com\/ct|linkedin\.com\/px|yandex\.ru\/metrika/i;

async function blockHeavyResources(page: import("playwright").Page): Promise<void> {
  await page.route("**/*", (route) => {
    const request = route.request();
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      return route.abort();
    }
    if (TRACKING_DOMAIN_RE.test(request.url())) {
      return route.abort();
    }
    return route.continue();
  });
}

async function renderOnce(url: string): Promise<{ html: string; priceSelectorMatched: boolean }> {
  const release = await acquireRenderSlot();
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });
    const page = await context.newPage();
    try {
      await blockHeavyResources(page);

      // domcontentloaded rather than load/networkidle — see GOTO_TIMEOUT_MS
      // comment above for why waiting for network silence was the direct
      // cause of most render timeouts.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });

      // The DOM being attached doesn't mean the listing content has
      // rendered yet (client-side data fetch/hydration). Explicitly wait for
      // a price-like element rather than assuming readiness — a miss here
      // is logged, not thrown, since the page may just genuinely have none.
      let priceSelectorMatched = true;
      try {
        await page.waitForSelector("text=/£\\s?\\d/", { timeout: PRICE_SELECTOR_TIMEOUT_MS });
      } catch {
        priceSelectorMatched = false;
        console.warn(`[autoAdapter] no £-price element appeared on ${url} within ${PRICE_SELECTOR_TIMEOUT_MS}ms`);
      }

      const html = await page.content();
      return { html, priceSelectorMatched };
    } finally {
      await context.close();
    }
  } finally {
    release();
  }
}

/** Renders a page with Playwright, with one automatic retry if the first
 * attempt times out (navigation or otherwise) before giving up. */
async function renderWithPlaywright(url: string): Promise<{ html: string; priceSelectorMatched: boolean }> {
  try {
    return await renderOnce(url);
  } catch (err) {
    console.warn(
      `[autoAdapter] render of ${url} failed, retrying once: ${err instanceof Error ? err.message : String(err)}`
    );
    return await renderOnce(url);
  }
}

// ---------- common intermediate shape ----------

// Exported so lqHomes.ts (a dedicated adapter, not the generic pipeline) can
// reuse the same AI-extraction fallback rather than duplicating it.
export interface RawExtractedItem {
  name: string | null;
  url: string | null;
  priceValue: number | null;
  priceText: string | null;
  bedrooms: number | null;
  postcode: string | null;
  image: string | null;
  tenure: TenureValue | null;
}

function finalizeListings(raw: RawExtractedItem[], developer: DeveloperEntry): AdapterListing[] {
  const listings: AdapterListing[] = [];
  const seenIds = new Set<string>();
  let index = 0;

  // Some developers in london-developers.json publish shared ownership as
  // their *only* tenure/scheme (Guinness Homes, MTVH, SO Resi, SNG, Hyde New
  // Homes, Sage Homes) — every listing from those really is shared
  // ownership even on a page that never uses the words itself, so it's
  // forced here rather than left to per-listing text detection. Developers
  // offering it alongside other schemes are NOT included in this check —
  // see isExclusivelySharedOwnershipProvider's own doc comment.
  const forceSharedOwnership = isExclusivelySharedOwnershipProvider(developer.tenures);

  for (const item of raw) {
    index++;
    // These three anchor whether something is a usable listing at all —
    // everything else stays null/absent rather than being guessed. The price
    // floor is a defensive backstop across all three strategies (see the
    // fuller comment on the same check in extractHtmlHeuristic).
    if (
      !item.name ||
      !item.url ||
      item.priceValue == null ||
      item.priceValue < MIN_PLAUSIBLE_PROPERTY_PRICE
    ) {
      continue;
    }

    const externalId = makeExternalId(developer.id, item.url, index);
    if (seenIds.has(externalId)) continue;
    seenIds.add(externalId);

    listings.push({
      externalId,
      title: item.name,
      price: item.priceText ?? `£${item.priceValue.toLocaleString("en-GB")}`,
      priceValue: item.priceValue,
      url: item.url,
      images: item.image ? [item.image] : [],
      mainImage: item.image,
      bedrooms: item.bedrooms,
      bedroomType: null, // not attempted generically — too source-specific to infer reliably
      tenure: forceSharedOwnership ? "shared_ownership" : item.tenure,
      isNewBuild: true,
      postcode: item.postcode ?? "",
      area: "",
    });
  }

  return listings;
}

function makeExternalId(developerId: string, url: string, index: number): string {
  try {
    const slug = new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
    return slug || `${developerId}-${index}`;
  } catch {
    return `${developerId}-${index}`;
  }
}

// ---------- strategy (a): JSON-LD / schema.org ----------

const JSONLD_TYPE_PATTERN =
  /product|offer|residence|apartment|house|singlefamilyresidence|realestatelisting|accommodation/i;

function flattenJsonLd(data: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  function walk(node: unknown) {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
    } else if (node && typeof node === "object") {
      out.push(node as Record<string, unknown>);
      const graph = (node as Record<string, unknown>)["@graph"];
      if (graph) walk(graph);
    }
  }
  walk(data);
  return out;
}

function mapJsonLdNode(node: Record<string, unknown>, baseUrl: string): RawExtractedItem | null {
  const type = node["@type"];
  const typeStr = Array.isArray(type) ? type.join(",") : String(type ?? "");
  if (!JSONLD_TYPE_PATTERN.test(typeStr)) return null;

  const name = firstString(node.name);
  const urlRaw = firstString(node.url);
  const url = urlRaw ? absoluteUrl(urlRaw, baseUrl) : null;

  let priceValue: number | null = null;
  const offers = node.offers as Record<string, unknown> | undefined;
  if (offers && typeof offers === "object" && !Array.isArray(offers)) {
    const p = offers.price ?? offers.lowPrice;
    priceValue = typeof p === "number" ? p : typeof p === "string" ? parsePriceNumber(p) : null;
  } else if (typeof node.price === "number" || typeof node.price === "string") {
    priceValue = typeof node.price === "number" ? node.price : parsePriceNumber(node.price);
  }

  const address = node.address as Record<string, unknown> | undefined;
  const postcode =
    address && typeof address === "object" ? firstString(address.postalCode) : null;

  const roomsRaw = node.numberOfRooms ?? node.numberOfBedroomsTotal;
  const bedrooms =
    typeof roomsRaw === "number"
      ? roomsRaw
      : typeof roomsRaw === "string" && /^\d+$/.test(roomsRaw)
        ? parseInt(roomsRaw, 10)
        : null;

  let image: string | null = null;
  const img = node.image;
  if (typeof img === "string") image = img;
  else if (Array.isArray(img) && typeof img[0] === "string") image = img[0];
  else if (img && typeof img === "object" && !Array.isArray(img)) {
    image = firstString((img as Record<string, unknown>).url);
  }
  if (image) image = absoluteUrl(image, baseUrl);

  if (!name || !url || priceValue == null) return null;

  return { name, url, priceValue, priceText: null, bedrooms, postcode, image, tenure: null };
}

function extractJsonLd(html: string, baseUrl: string): RawExtractedItem[] {
  const items: RawExtractedItem[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    for (const node of flattenJsonLd(data)) {
      const item = mapJsonLdNode(node, baseUrl);
      if (item) items.push(item);
    }
  }
  return items;
}

// ---------- strategy (b): embedded JSON blob (NEXT_DATA / window state) ----------

const PRICE_KEYS = new Set([
  "price",
  "Price",
  "fromPrice",
  "priceFrom",
  "startingPrice",
  "guidePrice",
  "priceGBP",
  "askingPrice",
]);
const BEDROOM_KEYS = new Set(["bedrooms", "beds", "numberOfBedrooms", "bedroomCount", "noOfBedrooms"]);
const NAME_KEYS = ["name", "title", "developmentName", "propertyName", "plotName", "houseTypeName"];
const URL_KEYS = ["url", "href", "link", "detailUrl", "propertyUrl"];
const IMAGE_KEYS = ["image", "img", "imageUrl", "photo", "thumbnail", "mainImage", "heroImage"];
const POSTCODE_KEYS = ["postcode", "postCode", "zip", "zipCode", "postalCode"];
const TENURE_KEYS = ["tenure", "Tenure"];

function pickKey(obj: Record<string, unknown>, keys: string[] | Set<string>): unknown {
  for (const k of Object.keys(obj)) {
    if (Array.isArray(keys) ? keys.includes(k) : keys.has(k)) return obj[k];
  }
  return undefined;
}

function looksLikeListingObject(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  return pickKey(o, PRICE_KEYS) !== undefined && (pickKey(o, BEDROOM_KEYS) !== undefined || pickKey(o, NAME_KEYS) !== undefined);
}

/** Walks a parsed JSON tree looking for arrays where most items look like
 * listing objects (has a price-ish key plus a bedroom- or name-ish key). */
function findListingLikeObjects(root: unknown, maxDepth = 10): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visited = new Set<unknown>();

  function walk(node: unknown, depth: number) {
    if (depth > maxDepth || node === null || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      const objectItems = node.filter((x) => typeof x === "object" && x !== null && !Array.isArray(x));
      if (objectItems.length >= 2) {
        const matching = objectItems.filter(looksLikeListingObject);
        if (matching.length >= 2 && matching.length / objectItems.length > 0.5) {
          found.push(...(matching as Record<string, unknown>[]));
          return;
        }
      }
      for (const item of node) walk(item, depth + 1);
    } else {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        walk((node as Record<string, unknown>)[key], depth + 1);
      }
    }
  }

  walk(root, 0);
  return found;
}

function mapEmbeddedJsonObject(obj: Record<string, unknown>, baseUrl: string): RawExtractedItem | null {
  const name = firstString(pickKey(obj, NAME_KEYS));
  const priceRaw = pickKey(obj, PRICE_KEYS);
  const priceValue =
    typeof priceRaw === "number" ? priceRaw : typeof priceRaw === "string" ? parsePriceNumber(priceRaw) : null;
  const urlRaw = firstString(pickKey(obj, URL_KEYS));
  const url = urlRaw ? absoluteUrl(urlRaw, baseUrl) : null;
  const bedroomsRaw = pickKey(obj, BEDROOM_KEYS);
  const bedrooms =
    typeof bedroomsRaw === "number"
      ? bedroomsRaw
      : typeof bedroomsRaw === "string" && /^\d+$/.test(bedroomsRaw)
        ? parseInt(bedroomsRaw, 10)
        : null;
  const postcode = firstString(pickKey(obj, POSTCODE_KEYS));
  const imageRaw = firstString(pickKey(obj, IMAGE_KEYS));
  const image = imageRaw ? absoluteUrl(imageRaw, baseUrl) : null;
  const tenure = detectTenure(firstString(pickKey(obj, TENURE_KEYS)));

  if (!name || !url || priceValue == null) return null;

  return { name, url, priceValue, priceText: null, bedrooms, postcode, image, tenure };
}

function extractEmbeddedJson(html: string, baseUrl: string): RawExtractedItem[] {
  const candidates: unknown[] = [];

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      candidates.push(JSON.parse(nextDataMatch[1]));
    } catch {
      /* not valid JSON — skip */
    }
  }

  const namedStateRe =
    /window\.(__NUXT__|__INITIAL_STATE__|__PRELOADED_STATE__|__APP_STATE__|__STATE__)\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>)/gi;
  let sm: RegExpExecArray | null;
  while ((sm = namedStateRe.exec(html))) {
    try {
      candidates.push(JSON.parse(sm[2]));
    } catch {
      /* likely a JS object literal, not strict JSON — skip rather than eval */
    }
  }

  const items: RawExtractedItem[] = [];
  for (const candidate of candidates) {
    for (const obj of findListingLikeObjects(candidate)) {
      const item = mapEmbeddedJsonObject(obj, baseUrl);
      if (item) items.push(item);
    }
  }
  return items;
}

// ---------- strategy (c): generic HTML heuristic ----------

const PRICE_TEXT_RE = /£\s?\d[\d,]{2,}/;
const MIN_PLAUSIBLE_PROPERTY_PRICE = 50_000;

function escapeClassName(cls: string): string {
  return cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function extractHtmlHeuristic(html: string, baseUrl: string): RawExtractedItem[] {
  if (!html.includes("£")) return []; // cheap bail-out before doing any DOM work

  const $ = cheerio.load(html);
  // Restrict to tags that plausibly hold price text directly, to keep the
  // walk bounded on large real-world pages.
  const candidateTags = "span, div, p, h1, h2, h3, h4, h5, strong, b, a, li";

  const priceLeafEls: any[] = [];
  $(candidateTags).each((_, el) => {
    const $el = $(el);
    const ownText = $el.clone().children().remove().end().text();
    if (PRICE_TEXT_RE.test(ownText)) priceLeafEls.push($el);
  });

  // Walk up from each price element to find a repeated "card" ancestor —
  // one whose first class name recurs several times across the page.
  const groups = new Map<string, Set<any>>();
  for (const $priceEl of priceLeafEls) {
    let node = $priceEl;
    for (let level = 0; level < 6; level++) {
      const parent = node.parent();
      if (!parent.length) break;
      const clsAttr = (parent.attr("class") || "").trim();
      const cls = clsAttr ? clsAttr.split(/\s+/)[0] : "";
      if (cls) {
        const count = $(`.${escapeClassName(cls)}`).length;
        if (count >= 3 && count <= 300) {
          if (!groups.has(cls)) groups.set(cls, new Set());
          groups.get(cls)!.add(parent[0]);
          break;
        }
      }
      node = parent;
    }
  }

  let bestEls: any[] = [];
  for (const set of groups.values()) {
    const els = Array.from(set);
    if (els.length > bestEls.length) bestEls = els;
  }
  if (bestEls.length < 2) return [];

  const items: RawExtractedItem[] = [];
  for (const dom of bestEls) {
    const $card = $(dom);
    const text = $card.text().replace(/\s+/g, " ").trim();
    const priceMatch = text.match(PRICE_TEXT_RE);
    if (!priceMatch) continue;
    const priceValue = parsePriceNumber(priceMatch[0]);
    // A generic, non-site-specific sanity floor: real UK property prices
    // (including shared-ownership shares) are never this low. Without this,
    // repeated marketing tiles ("Get Cashback £25,000", "Recommend a Friend
    // £5,000") that share a card class with real listings elsewhere on the
    // same page get misread as homes — confirmed happening on Bellway,
    // Fairview, and Higgins during testing.
    if (priceValue == null || priceValue < MIN_PLAUSIBLE_PROPERTY_PRICE) continue;

    const isStudio = /\bstudio\b/i.test(text);
    const bedroomMatch = text.match(/(\d+)\s*(?:bed|bedroom)s?\b/i);
    const bedrooms = isStudio ? 0 : bedroomMatch ? parseInt(bedroomMatch[1], 10) : null;

    const postcodeMatch = text.match(/[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}/i);

    const linkHref = $card.is("a") ? $card.attr("href") : $card.find("a[href]").first().attr("href");
    const url = linkHref ? absoluteUrl(linkHref, baseUrl) : null;

    const imgSrc = $card.find("img").first().attr("src") || $card.find("img").first().attr("data-src") || null;
    const image = imgSrc ? absoluteUrl(imgSrc, baseUrl) : null;

    const nameCandidate =
      $card.find("h1,h2,h3,h4,h5").first().text().trim() ||
      ($card.is("a") ? $card.text().trim() : $card.find("a").first().text().trim());

    if (!url || !nameCandidate) continue;

    items.push({
      name: nameCandidate.replace(/\s+/g, " "),
      url,
      priceValue,
      priceText: priceMatch[0].replace(/\s+/g, ""),
      bedrooms,
      postcode: postcodeMatch ? postcodeMatch[0].toUpperCase() : null,
      image,
      // Full card text, not a narrow pre-matched substring — a "25% share"
      // or "Shared Ownership" mention can sit anywhere in the card, and
      // must win over a "leasehold" mention elsewhere in the same card
      // (see detectTenure's doc comment).
      tenure: detectTenure(text),
    });
  }
  return items;
}

// ---------- strategy (d): AI extraction (last resort, rendered pages only) ----------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-5";
const AI_EXTRACTION_TIMEOUT_MS = 45_000;
// Sensible cap on what gets sent — keeps cost/latency bounded and stays well
// under the model's context window even for a large rendered page.
const AI_EXTRACTION_MAX_INPUT_CHARS = 15_000;

interface AiRawListing {
  name?: unknown;
  price?: unknown;
  priceRange?: unknown;
  bedrooms?: unknown;
  tenure?: unknown;
  postcode?: unknown;
  location?: unknown;
  imageUrl?: unknown;
  listingUrl?: unknown;
}

/** Strips script/style/svg/comments, keeping the rest of the tagged HTML
 * (so the model can still see hrefs/img srcs) plus a plain-text rendering. */
function prepareAiInput(html: string): { visibleText: string; strippedHtml: string } {
  const strippedHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const visibleText = strippedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { visibleText, strippedHtml };
}

/** Best-effort extraction of a JSON array from a model response that's
 * supposed to be JSON-only but might still wrap it in prose/code fences. */
function extractJsonArrayText(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  return (arrayMatch ? arrayMatch[0] : candidate).trim();
}

/**
 * Validates and normalises the model's raw output. Per-item: drops anything
 * missing a name or price, and drops anything whose name doesn't actually
 * appear in the source text we sent — i.e. it must be grounded in real page
 * content, not just a plausible-sounding invention. Whole-result: discards
 * everything if the listing URLs aren't on the page's own domain (real
 * listings on a developer's page link within that site) or if prices are
 * suspiciously repetitive (a templated/fabricated-data smell).
 */
function validateAndNormalizeAiListings(
  raw: unknown,
  baseUrl: string,
  visibleText: string
): RawExtractedItem[] {
  if (!Array.isArray(raw)) return [];
  const lowerText = visibleText.toLowerCase();
  const grounded: RawExtractedItem[] = [];

  for (const entry of raw as AiRawListing[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = firstString(entry.name);
    const priceValue =
      typeof entry.price === "number"
        ? entry.price
        : typeof entry.price === "string"
          ? parsePriceNumber(entry.price)
          : null;
    if (!name || priceValue == null) continue;

    // Grounding check: a real extraction should be able to point back at
    // text that's actually on the page, not just produce something
    // real-estate-shaped.
    const nameSnippet = name.toLowerCase().slice(0, 24);
    if (nameSnippet.length >= 4 && !lowerText.includes(nameSnippet)) continue;

    const listingUrlRaw = firstString(entry.listingUrl);
    const imageUrlRaw = firstString(entry.imageUrl);
    const bedroomsRaw = entry.bedrooms;
    const bedrooms =
      typeof bedroomsRaw === "number"
        ? bedroomsRaw
        : typeof bedroomsRaw === "string" && /^\d+$/.test(bedroomsRaw)
          ? parseInt(bedroomsRaw, 10)
          : null;

    grounded.push({
      name,
      url: listingUrlRaw ? absoluteUrl(listingUrlRaw, baseUrl) : null,
      priceValue,
      priceText: firstString(entry.priceRange),
      bedrooms,
      postcode: firstString(entry.postcode),
      image: imageUrlRaw ? absoluteUrl(imageUrlRaw, baseUrl) : null,
      tenure: detectTenure(firstString(entry.tenure)),
    });
  }

  if (grounded.length === 0) return [];

  const withUrls = grounded.filter((g) => g.url);
  if (withUrls.length > 0) {
    let baseOrigin: string | null = null;
    try {
      baseOrigin = new URL(baseUrl).origin;
    } catch {
      baseOrigin = null;
    }
    const sameOriginCount = baseOrigin
      ? withUrls.filter((g) => {
          try {
            return new URL(g.url!).origin === baseOrigin;
          } catch {
            return false;
          }
        }).length
      : 0;
    // Real listings link within the developer's own site. None doing so is
    // a strong sign the whole batch was invented rather than extracted.
    if (baseOrigin && sameOriginCount === 0) return [];
  }

  if (grounded.length >= 3) {
    const priceCounts = new Map<number, number>();
    // Non-null: every item pushed into `grounded` above was only pushed
    // after confirming priceValue != null.
    for (const g of grounded) priceCounts.set(g.priceValue!, (priceCounts.get(g.priceValue!) ?? 0) + 1);
    const maxRepeat = Math.max(...priceCounts.values());
    // >60% of "distinct" listings sharing one exact price looks templated,
    // not like real, independently-priced properties.
    if (maxRepeat / grounded.length > 0.6) return [];
  }

  return grounded;
}

/** Last-resort extraction via the Anthropic API — only reached when JSON-LD,
 * embedded JSON, and the HTML heuristic have all failed on a rendered page.
 * Returns [] (never throws for "the model found nothing" or "no API key
 * configured") so callers can fall through to the normal no_pattern_found
 * path; genuine API/network failures do throw, and are logged by the caller. */
export async function extractWithAi(
  html: string,
  baseUrl: string,
  attempted: string[]
): Promise<RawExtractedItem[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    attempted.push("ai_extraction:no_api_key");
    return [];
  }

  const { visibleText, strippedHtml } = prepareAiInput(html);
  const cappedText = visibleText.slice(0, AI_EXTRACTION_MAX_INPUT_CHARS);
  const cappedHtml = strippedHtml.slice(0, AI_EXTRACTION_MAX_INPUT_CHARS);

  const prompt =
    `Extract every property/development listing on this page as a JSON array. For each, give: ` +
    `name, price (number, the starting price if a range), priceRange (string, if shown), bedrooms ` +
    `(number or null), tenure (string or null), postcode (string or null), location (string or null), ` +
    `imageUrl (string or null), listingUrl (string or null).\n\n` +
    `Only include real listings actually present in this content. If there are none, return an empty ` +
    `array. Never invent data.\n\n` +
    `Respond with ONLY a JSON array — no markdown, no commentary, no code fences.\n\n` +
    `PAGE URL: ${baseUrl}\n\n` +
    `VISIBLE TEXT:\n${cappedText}\n\n` +
    `HTML:\n${cappedHtml}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(AI_EXTRACTION_TIMEOUT_MS),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Anthropic API returned HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const textBlock = data.content?.find((b) => b.type === "text")?.text;
  if (!textBlock) {
    throw new Error("Anthropic API response had no text content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArrayText(textBlock));
  } catch (err) {
    throw new Error(`AI response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  return validateAndNormalizeAiListings(parsed, baseUrl, visibleText);
}

// ---------- entry point ----------

/** Tries all three deterministic extraction strategies in priority order
 * against a given HTML string; returns the first that yields at least one
 * usable listing. */
function tryStrategies(
  html: string,
  baseUrl: string,
  developer: DeveloperEntry,
  attempted: string[]
): { listings: AdapterListing[]; method: string } | null {
  let raw = extractJsonLd(html, baseUrl);
  if (raw.length > 0) {
    const listings = finalizeListings(raw, developer);
    if (listings.length > 0) return { listings, method: "json-ld" };
  }
  attempted.push("json-ld");

  raw = extractEmbeddedJson(html, baseUrl);
  if (raw.length > 0) {
    const listings = finalizeListings(raw, developer);
    if (listings.length > 0) return { listings, method: "embedded-json" };
  }
  attempted.push("embedded-json");

  raw = extractHtmlHeuristic(html, baseUrl);
  if (raw.length > 0) {
    const listings = finalizeListings(raw, developer);
    if (listings.length > 0) return { listings, method: "html-heuristic" };
  }
  attempted.push("html-heuristic");

  return null;
}

/** The full fetch → (maybe Playwright) → strategy pipeline, against a given
 * URL — not necessarily `developer.listings_url`. Factored out so it can be
 * run both against the developer's recorded listings_url (the normal case)
 * and, for developers currently in `error` status, against candidate URLs
 * found by discoverCandidateUrls() below (see createAutoAdapter). */
async function attemptExtraction(targetUrl: string, developer: DeveloperEntry): Promise<AdapterRunResult> {
  const attempted: string[] = [];
  let baseUrl: string;
  try {
    baseUrl = new URL(targetUrl).origin;
  } catch {
    throw new AdapterAutoExtractionError("parse_error", `"${targetUrl}" is not a valid URL.`, []);
  }

  // Step 1: plain fetch. A full browser is heavier, so this stays the
  // fast path — only escalated to Playwright when it doesn't work out.
  let fetchResult: FetchResult | null = null;
  let fetchError: unknown = null;
  try {
    fetchResult = await fetchText(targetUrl);
    attempted.push("fetch");
  } catch (err) {
    fetchError = err;
    attempted.push("fetch:failed");
  }

  let html: string | null = null;
  let renderedViaPlaywright = false;

  if (fetchResult) {
    if (isBotBlockSignal(fetchResult.status, fetchResult.text)) {
      // Retry once through a real browser after a short randomised
      // delay, per the "blocked" retry policy — no CAPTCHA-solving, no
      // proxies, just a normal second look with a real render.
      attempted.push("blocked-on-fetch");
      await delay(randomDelayMs(1500, 4000));
      let retryHtml: string;
      try {
        const rendered = await renderWithPlaywright(targetUrl);
        retryHtml = rendered.html;
        attempted.push(rendered.priceSelectorMatched ? "playwright-retry" : "playwright-retry:no-price-selector");
      } catch (err) {
        throw new AdapterHttpError(
          `${developer.name}: blocked on first request; browser retry also failed to load ` +
            `(${err instanceof Error ? err.message : String(err)}) — needs manual review`,
          fetchResult.status,
          fetchResult.text.slice(0, 3000)
        );
      }
      if (isBotBlockSignal(200, retryHtml)) {
        throw new AdapterHttpError(
          `${developer.name}: still shows a bot-block/challenge page after a browser retry — needs manual review`,
          200,
          retryHtml.slice(0, 3000)
        );
      }
      html = retryHtml;
      renderedViaPlaywright = true;
    } else if (fetchResult.status < 200 || fetchResult.status >= 300) {
      throw new AdapterHttpError(
        `${developer.name}: unexpected HTTP ${fetchResult.status}`,
        fetchResult.status,
        fetchResult.text.slice(0, 3000)
      );
    } else {
      html = fetchResult.text;
    }
  }

  // Step 2: if we have un-rendered static HTML, try it as-is first
  // (unless it's an obvious JS-app shell), then fall back to a real
  // Playwright render — covering both "looked empty" and "had plenty of
  // static HTML but the listings themselves are injected client-side".
  if (html !== null && !renderedViaPlaywright) {
    if (!looksJsRendered(html)) {
      const result = tryStrategies(html, baseUrl, developer, attempted);
      if (result) {
        return { httpStatus: fetchResult!.status, listings: result.listings, extractionMethod: result.method };
      }
    } else {
      attempted.push("js-detected");
    }

    try {
      const rendered = await renderWithPlaywright(targetUrl);
      html = rendered.html;
      renderedViaPlaywright = true;
      attempted.push(rendered.priceSelectorMatched ? "playwright-render" : "playwright-render:no-price-selector");
    } catch (err) {
      throw new AdapterAutoExtractionError(
        "js_required",
        `Static extraction found nothing and a Playwright render failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        attempted
      );
    }
    if (isBotBlockSignal(200, html)) {
      throw new AdapterHttpError(
        `${developer.name}: rendered page looked like a bot-block/challenge page`,
        200,
        html.slice(0, 3000)
      );
    }
  }

  // Step 3: plain fetch failed outright (network/DNS/etc.) — try a real
  // browser as a last resort before giving up.
  if (html === null) {
    try {
      const rendered = await renderWithPlaywright(targetUrl);
      html = rendered.html;
      renderedViaPlaywright = true;
      attempted.push(rendered.priceSelectorMatched ? "playwright-fallback" : "playwright-fallback:no-price-selector");
    } catch (renderErr) {
      throw new AdapterAutoExtractionError(
        "parse_error",
        `Network error on plain fetch (${fetchError instanceof Error ? fetchError.message : String(fetchError)}); ` +
          `browser fallback also failed (${renderErr instanceof Error ? renderErr.message : String(renderErr)}).`,
        attempted
      );
    }
    if (isBotBlockSignal(200, html)) {
      throw new AdapterHttpError(
        `${developer.name}: rendered page looked like a bot-block/challenge page`,
        200,
        html.slice(0, 3000)
      );
    }
  }

  // Step 4: extract from whatever HTML we ended up with (rendered, via
  // any of the paths above).
  const result = tryStrategies(html, baseUrl, developer, attempted);
  if (result) {
    return {
      httpStatus: fetchResult?.status ?? 200,
      listings: result.listings,
      extractionMethod: renderedViaPlaywright ? `${result.method} (playwright)` : result.method,
    };
  }

  // Step 5: last resort — ask the model to read the rendered page
  // itself. Only attempted on a genuinely rendered page (never on raw
  // static HTML). A miss (no key configured, model found nothing, or
  // its output didn't survive the grounding/fabrication checks) just
  // falls through to the normal no_pattern_found error below like any
  // other failed strategy — an AI-side failure never substitutes fake
  // data or its own bespoke error reason.
  if (renderedViaPlaywright) {
    try {
      const aiRaw = await extractWithAi(html, baseUrl, attempted);
      if (aiRaw.length > 0) {
        const listings = finalizeListings(aiRaw, developer);
        if (listings.length > 0) {
          attempted.push("ai_extraction");
          return { httpStatus: fetchResult?.status ?? 200, listings, extractionMethod: "ai_extraction" };
        }
      }
      attempted.push("ai_extraction:no_listings");
    } catch (err) {
      attempted.push(`ai_extraction:failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  throw new AdapterAutoExtractionError(
    "no_pattern_found",
    `No JSON-LD, embedded JSON, repeated £-price card pattern, or AI extraction found real listings ` +
      `on ${targetUrl}` +
      `${renderedViaPlaywright ? " (checked both static and Playwright-rendered HTML)" : ""}.`,
    attempted
  );
}

// ---------- UK/London filter (discovered-URL path only) ----------

const OVERSEAS_SIGNAL_RE =
  /\bireland\b|\bdublin\b|\bcork\b|\bgalway\b|\bwestmeath\b|\bkildare\b|\bfrance\b|\bspain\b|\bportugal\b|\bdubai\b|\buae\b|\bu\.?s\.?a\.?\b|\bunited states\b|\bnew york\b|\bgermany\b|\bnetherlands\b/i;

/**
 * Generic auto-extraction has no dedicated location/area field (see
 * finalizeListings — `area` is always ""), so this only has `title`, `url`,
 * and `postcode` to go on. Requires a *positive* London signal rather than
 * just the absence of an overseas one — confirmed necessary live: Bellway's
 * discovered candidate was https://www.bellway.co.uk/new-homes/eastern-
 * counties/hatton-gate, a real UK page with real UK postcodes, but Eastern
 * Counties, not London — "not overseas" alone would have wrongly let it
 * through. Only applied to the discovered-URL path — the existing
 * developer.listings_url path is unchanged.
 */
function isLikelyLondonListing(listing: AdapterListing): boolean {
  const haystack = `${listing.title} ${listing.url}`;
  if (OVERSEAS_SIGNAL_RE.test(`${haystack} ${listing.postcode}`)) return false;

  const postcode = listing.postcode.trim();
  if (postcode) {
    return postcodeAreaIsLondon(postcode);
  }

  // No postcode captured — only fall back to an explicit "London" mention
  // in the title/url; no postcode AND no "London" mention is not enough
  // evidence to include, given the Eastern Counties case above.
  return /\blondon\b/i.test(haystack);
}

// ---------- URL discovery orchestration (error-status developers only) ----------

async function getStoredStatus(developerId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("sync_status")
    .select("status")
    .eq("source_id", developerId)
    .maybeSingle<{ status: string }>();
  if (error) {
    // Best-effort read used only to decide whether to run URL discovery —
    // a read hiccup here should fall back to the normal (non-discovery)
    // path, not fail the whole adapter run.
    console.warn(`[autoAdapter] getStoredStatus(${developerId}): read failed: ${error.message}`);
    return null;
  }
  return data?.status ?? null;
}

export function createAutoAdapter(developer: DeveloperEntry): SourceAdapter {
  return {
    id: developer.id,
    name: developer.name,

    async run(): Promise<AdapterRunResult> {
      if ((await getStoredStatus(developer.id)) !== "error") {
        return attemptExtraction(developer.listings_url, developer);
      }

      // Currently in `error` — the recorded listings_url alone hasn't been
      // yielding real listings (often because it's just the homepage, not
      // a developments/search page). Try discovering a better URL from the
      // site itself before falling back to the existing behaviour.
      const discoveryLog: string[] = [];
      let candidates: string[] = [];
      try {
        const discovery = await discoverCandidateUrls(developer);
        candidates = discovery.candidates;
        discoveryLog.push(...discovery.notes);
      } catch (err) {
        discoveryLog.push(`discovery itself failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      for (const candidateUrl of candidates) {
        try {
          const result = await attemptExtraction(candidateUrl, developer);
          const londonListings = result.listings.filter(isLikelyLondonListing);
          if (londonListings.length === 0) {
            discoveryLog.push(
              `${candidateUrl}: extraction found ${result.listings.length} listing(s) but none looked UK/London`
            );
            continue;
          }

          const saved = updateListingsUrlInFile(developer.id, candidateUrl);
          console.warn(
            `[auto-adapter] ${developer.name}: URL discovery found a working listings page at ${candidateUrl} ` +
              `(${londonListings.length} UK/London listing(s))` +
              (saved ? " — saved to london-developers.json" : " — could not update london-developers.json")
          );

          return {
            ...result,
            listings: londonListings,
            extractionMethod: `${result.extractionMethod ?? "unknown"} (discovered)`,
          };
        } catch (err) {
          discoveryLog.push(`${candidateUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // No discovered candidate worked (or none were found) — fall back to
      // the existing listings_url, same as before discovery existed. The
      // discovery attempts are folded into the failure so the real reason —
      // including every candidate URL tried — is fully logged either way.
      try {
        return await attemptExtraction(developer.listings_url, developer);
      } catch (err) {
        if (discoveryLog.length > 0 && err instanceof Error) {
          err.message += ` | URL discovery also tried: ${discoveryLog.join("; ")}`;
        }
        throw err;
      }
    },
  };
}
