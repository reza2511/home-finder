/**
 * Property comparison page's per-URL extraction — fetch/render a single
 * arbitrary property-listing URL the same way the sync's generic
 * auto-adapter does (lib/adapters/autoAdapter.ts: plain fetch first, escalate
 * to a real Playwright render on a bot-block or an empty JS-app shell), then
 * ask the Anthropic API to read the rendered page and extract nine fields —
 * never the multi-listing JSON-LD/embedded-json/heuristic strategies those
 * adapters use, since a compare URL is one specific property page, not a
 * developer's whole search-results page.
 *
 * Honesty rules, mirroring every adapter in this app:
 *  - A field the page doesn't state is left `null`, never guessed.
 *  - Every non-null string the model returns is checked against the page's
 *    own visible text (normalized to alphanumerics) before being trusted —
 *    a value that doesn't actually appear on the page is dropped rather
 *    than shown, the same "grounding" defence autoAdapter.ts's own AI
 *    fallback uses against fabrication.
 *  - A blocked or failed fetch/render never falls through to a guess — it's
 *    reported as `status: "blocked"` / `"error"` with an honest message, so
 *    the comparison table can show "Could not read" instead of faking a row.
 */
import { getSharedBrowser } from "./adapters/browser";
import { isBotBlockSignal } from "./adapters/blockDetection";

const FETCH_TIMEOUT_MS = 15_000;
const GOTO_TIMEOUT_MS = 60_000;
const AI_EXTRACTION_TIMEOUT_MS = 45_000;
const AI_EXTRACTION_MAX_INPUT_CHARS = 15_000;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};

export interface ComparePropertyFields {
  name: string | null;
  location: string | null;
  postcode: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  floorArea: string | null;
  parking: string | null;
  price: string | null;
  lastSoldPrice: string | null;
}

export type CompareResult =
  | { url: string; status: "ok"; fields: ComparePropertyFields }
  | { url: string; status: "blocked" | "error"; message: string };

const FIELD_KEYS: (keyof ComparePropertyFields)[] = [
  "name",
  "location",
  "postcode",
  "bedrooms",
  "bathrooms",
  "floorArea",
  "parking",
  "price",
  "lastSoldPrice",
];

// ---------- fetch / render ----------

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

async function renderWithPlaywright(url: string): Promise<string> {
  const browser = await getSharedBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: "en-GB",
    extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
    // A real listing page's price/details are frequently injected client-side
    // after the initial DOM — give it a beat before reading content, same
    // "domcontentloaded then a short settle" approach the sync's adapters use.
    await page.waitForTimeout(1500);
    return await page.content();
  } finally {
    await context.close();
  }
}

interface PageContentResult {
  html: string;
  blocked: boolean;
}

/** Plain fetch first (fast path); escalates to a real Playwright render on a
 * bot-block, an outright network failure, or static HTML that looks like an
 * empty JS-app shell — the same escalation ladder
 * lib/adapters/autoAdapter.ts uses for the sync's own sources. */
async function getPageContent(url: string): Promise<PageContentResult> {
  let fetchHtml: string | null = null;
  let fetchStatus: number | null = null;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    fetchStatus = res.status;
    fetchHtml = await res.text();
  } catch {
    fetchHtml = null; // network/DNS/timeout — fall through to a Playwright attempt below
  }

  if (fetchHtml !== null && !isBotBlockSignal(fetchStatus, fetchHtml) && !looksJsRendered(fetchHtml)) {
    return { html: fetchHtml, blocked: false };
  }

  // Either the plain fetch failed outright, looked blocked, or returned an
  // empty JS-app shell — try a real browser render before giving up.
  let renderedHtml: string;
  try {
    renderedHtml = await renderWithPlaywright(url);
  } catch {
    // Render also failed — if the plain fetch at least returned *something*
    // non-blocked, fall back to that rather than reporting a hard error for
    // a page that was actually just slow to render.
    if (fetchHtml !== null && !isBotBlockSignal(fetchStatus, fetchHtml)) {
      return { html: fetchHtml, blocked: false };
    }
    throw new Error("could not load the page (network error and browser render both failed)");
  }

  if (isBotBlockSignal(200, renderedHtml)) {
    return { html: renderedHtml, blocked: true };
  }
  return { html: renderedHtml, blocked: false };
}

// ---------- AI extraction ----------

function prepareAiInput(html: string): { visibleText: string; strippedHtml: string } {
  const strippedHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const visibleText = strippedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { visibleText, strippedHtml };
}

function extractJsonObjectText(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  return (objectMatch ? objectMatch[0] : candidate).trim();
}

/** Normalizes to lowercase alphanumerics only, so currency symbols, commas,
 * and whitespace differences between the model's phrasing and the page's
 * own text don't cause a real match to be rejected. */
function normalizeForGrounding(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** True if `value` (a field the model claims the page states) genuinely
 * appears in `visibleText` — the page's own rendered text, not the model's
 * say-so. Short values (<2 normalized chars) are rejected outright: too
 * easy to "match" by coincidence to mean anything. */
function isGrounded(value: string, visibleText: string): boolean {
  const normalizedValue = normalizeForGrounding(value);
  if (normalizedValue.length < 2) return false;
  return normalizeForGrounding(visibleText).includes(normalizedValue);
}

const PROMPT = `You are extracting structured facts about ONE property/development from the page content below. For each of these 9 fields, give the value EXACTLY as stated on the page (copy the page's own wording/formatting), or null if the page does not genuinely state it. Never guess, estimate, or infer a value that isn't actually written on the page.

Fields:
- name: the property or development's name/title
- location: the general area, neighbourhood, or town
- postcode: a postcode, if stated
- bedrooms: number of bedrooms, as stated (e.g. "2", "Studio")
- bathrooms: number of bathrooms, as stated
- floorArea: floor area/size, including its unit (e.g. "850 sq ft", "79 m²")
- parking: parking details, as stated (e.g. "1 allocated space", "None")
- price: the current asking/listed price, as stated
- lastSoldPrice: a previous purchase/sold price, ONLY if the page explicitly shows one (e.g. a sold-price-history section) — this is absent on most listing pages; leave it null unless genuinely present

Respond with ONLY a single JSON object with exactly these 9 keys (name, location, postcode, bedrooms, bathrooms, floorArea, parking, price, lastSoldPrice), each a string or null. No markdown, no commentary, no code fences.`;

async function callAnthropic(apiKey: string, visibleText: string, strippedHtml: string, pageUrl: string): Promise<unknown> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content:
            `${PROMPT}\n\nPAGE URL: ${pageUrl}\n\nVISIBLE TEXT:\n${visibleText.slice(0, AI_EXTRACTION_MAX_INPUT_CHARS)}\n\n` +
            `HTML:\n${strippedHtml.slice(0, AI_EXTRACTION_MAX_INPUT_CHARS)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(AI_EXTRACTION_TIMEOUT_MS),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Anthropic API returned HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const textBlock = data.content?.find((b) => b.type === "text")?.text;
  if (!textBlock) throw new Error("Anthropic API response had no text content");

  try {
    return JSON.parse(extractJsonObjectText(textBlock));
  } catch (err) {
    throw new Error(`AI response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeAndGroundFields(raw: unknown, visibleText: string): ComparePropertyFields {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fields = {} as ComparePropertyFields;
  for (const key of FIELD_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "" && isGrounded(value, visibleText)) {
      fields[key] = value.trim();
    } else {
      fields[key] = null; // not stated, wrong type, or not actually found on the page — never guessed
    }
  }
  return fields;
}

// ---------- entry point ----------

/** Fetches/renders `url`, then asks the Anthropic API to extract the 9
 * comparison fields, grounding every value against the page's own text
 * before trusting it. Never throws over an expected failure mode (blocked,
 * fetch error, missing API key, bad AI response) — those all become a
 * `status: "blocked" | "error"` result instead, so the compare route can
 * process every URL independently and report each one honestly. */
export async function extractPropertyFromUrl(url: string): Promise<CompareResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    return { url, status: "error", message: "Not a valid http(s) URL." };
  }

  let page: PageContentResult;
  try {
    page = await getPageContent(parsed.toString());
  } catch (err) {
    return { url, status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (page.blocked) {
    return { url, status: "blocked", message: "This site blocked the request (bot-detection/challenge page)." };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { url, status: "error", message: "AI extraction is not configured (ANTHROPIC_API_KEY is not set)." };
  }

  const { visibleText, strippedHtml } = prepareAiInput(page.html);
  if (visibleText.length < 50) {
    return { url, status: "error", message: "The page loaded but had no readable content to extract from." };
  }

  let raw: unknown;
  try {
    raw = await callAnthropic(apiKey, visibleText, strippedHtml, parsed.toString());
  } catch (err) {
    return { url, status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const fields = normalizeAndGroundFields(raw, visibleText);
  return { url, status: "ok", fields };
}
