/**
 * Property Tracker's per-URL extraction — same fetch/render/AI-extract/
 * ground approach as lib/compareExtract.ts (that file's own header explains
 * the escalation ladder and the grounding defence in full; this is a
 * deliberate near-duplicate of its fetch + grounding helpers, not a shared
 * import, so the two pages can evolve their own field sets independently —
 * same reasoning compareExtract.ts itself gives for not sharing autoAdapter.ts's
 * multi-listing strategies), but extracting a different field set: the
 * seven Property Tracker columns that can genuinely come off a listing page
 * (price, bedrooms, floor, developer, address, area, postcode) rather than
 * the nine comparison fields.
 *
 * Honesty rules, identical to compareExtract.ts:
 *  - A field the page doesn't state is left `null`, never guessed.
 *  - Every non-null string the model returns is checked against the page's
 *    own visible text before being trusted — ungrounded values are dropped.
 *  - A blocked or failed fetch/render never falls through to a guess — it's
 *    reported as `status: "blocked"` / `"error"` with an honest message, so
 *    the tracker can still add the row (blank fields, manual entry) with a
 *    "couldn't read this page" note instead of silently failing to add it.
 */
import { withBrowser } from "./adapters/browser";
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

export interface TrackerExtractedFields {
  price: string | null;
  bedrooms: string | null;
  /** Which floor the unit itself is on (e.g. "3rd floor", "Ground floor") —
   * NOT floor area/size. */
  floor: string | null;
  developer: string | null;
  address: string | null;
  area: string | null;
  postcode: string | null;
}

export type TrackerExtractResult =
  | { status: "ok"; fields: TrackerExtractedFields }
  | { status: "blocked" | "error"; message: string };

const FIELD_KEYS: (keyof TrackerExtractedFields)[] = [
  "price",
  "bedrooms",
  "floor",
  "developer",
  "address",
  "area",
  "postcode",
];

// ---------- fetch / render (identical approach to compareExtract.ts) ----------

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
  return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      await page.waitForTimeout(1500);
      return await page.content();
    } finally {
      await context.close();
    }
  });
}

interface PageContentResult {
  html: string;
  blocked: boolean;
}

async function getPageContent(url: string): Promise<PageContentResult> {
  let fetchHtml: string | null = null;
  let fetchStatus: number | null = null;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    fetchStatus = res.status;
    fetchHtml = await res.text();
  } catch {
    fetchHtml = null;
  }

  if (fetchHtml !== null && !isBotBlockSignal(fetchStatus, fetchHtml) && !looksJsRendered(fetchHtml)) {
    return { html: fetchHtml, blocked: false };
  }

  let renderedHtml: string;
  try {
    renderedHtml = await renderWithPlaywright(url);
  } catch {
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

function normalizeForGrounding(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isGrounded(value: string, visibleText: string): boolean {
  const normalizedValue = normalizeForGrounding(value);
  if (normalizedValue.length < 2) return false;
  return normalizeForGrounding(visibleText).includes(normalizedValue);
}

const PROMPT = `You are extracting structured facts about ONE property listing from the page content below. For each of these 7 fields, give the value EXACTLY as stated on the page (copy the page's own wording/formatting), or null if the page does not genuinely state it. Never guess, estimate, or infer a value that isn't actually written on the page.

Fields:
- price: the current asking/listed price, as stated
- bedrooms: number of bedrooms, as stated (e.g. "2", "Studio")
- floor: which floor the specific unit/apartment is on, if stated (e.g. "3rd floor", "Ground floor", "Penthouse") — this is about the unit's floor level, NOT the floor area/size
- developer: the property developer or builder's name, if stated
- address: the property's street address, as stated
- area: the general area, neighbourhood, or town
- postcode: a postcode, if stated

Respond with ONLY a single JSON object with exactly these 7 keys (price, bedrooms, floor, developer, address, area, postcode), each a string or null. No markdown, no commentary, no code fences.`;

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

function normalizeAndGroundFields(raw: unknown, visibleText: string): TrackerExtractedFields {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fields = {} as TrackerExtractedFields;
  for (const key of FIELD_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "" && isGrounded(value, visibleText)) {
      fields[key] = value.trim();
    } else {
      fields[key] = null;
    }
  }
  return fields;
}

// ---------- entry point ----------

/** Fetches/renders `url`, then asks the Anthropic API to extract the 7
 * Property Tracker fields, grounding every value against the page's own
 * text before trusting it. Never throws over an expected failure mode
 * (blocked, fetch error, missing API key, bad AI response) — those all
 * become a `status: "blocked" | "error"` result instead, so the caller can
 * still create the tracker row with blank fields and an honest note rather
 * than losing the URL the operator just pasted in. */
export async function extractTrackerFieldsFromUrl(url: string): Promise<TrackerExtractResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    return { status: "error", message: "Not a valid http(s) URL." };
  }

  let page: PageContentResult;
  try {
    page = await getPageContent(parsed.toString());
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (page.blocked) {
    return { status: "blocked", message: "This site blocked the request (bot-detection/challenge page)." };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: "error", message: "AI extraction is not configured (ANTHROPIC_API_KEY is not set)." };
  }

  const { visibleText, strippedHtml } = prepareAiInput(page.html);
  if (visibleText.length < 50) {
    return { status: "error", message: "The page loaded but had no readable content to extract from." };
  }

  let raw: unknown;
  try {
    raw = await callAnthropic(apiKey, visibleText, strippedHtml, parsed.toString());
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const fields = normalizeAndGroundFields(raw, visibleText);
  return { status: "ok", fields };
}
