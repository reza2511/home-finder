/**
 * Structured-data reading for ONE property page — the "JSON-LD / embedded
 * JSON" half of the tracker's read pipeline (lib/trackerExtract.ts calls
 * this before falling back to the Anthropic API). Deliberately separate
 * from lib/adapters/autoAdapter.ts's own JSON-LD/embedded-JSON strategies:
 * those are built to find an ARRAY of many listing-like objects on a
 * developer's search-results page (and require a price + name/bedroom key
 * together before trusting a node — right for picking one real listing out
 * of a page full of unrelated objects). A tracker/compare URL is always ONE
 * specific property's own page, so this reads every JSON-LD block on it
 * with no such filter — schema.org's per-property shapes vary too much
 * (`priceRange` vs `offers.price`, `HomeAndConstructionBusiness` vs
 * `Product`/`Residence`) to gate on a fixed @type or key set the way a
 * multi-listing page can.
 *
 * Confirmed live against a real Barratt London plot page
 * (barratthomes.co.uk/new-homes/.../plot-2-h86102/): its JSON-LD has no
 * `offers`/`price` field at all (only `priceRange: "£350,000 - £350,000"`)
 * and its @type is `HomeAndConstructionBusiness` — neither would have
 * matched autoAdapter.ts's mapJsonLdNode, which is why the tracker was
 * previously 100% dependent on the AI call even for a page this readable.
 *
 * Every value this returns still goes through the exact same
 * isGrounded() check as the AI's output before being trusted (see
 * lib/trackerExtract.ts) — reading it from structured data instead of
 * free text is a reliability improvement, not a loosening of the
 * never-fabricate rule.
 */
import type { TrackerExtractedFields } from "./trackerExtract";

// ---------- JSON-LD ----------

function flattenJsonLdNodes(data: unknown): Record<string, unknown>[] {
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

function firstNonEmptyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function typeNameOf(node: Record<string, unknown>): string {
  const type = node["@type"];
  return (Array.isArray(type) ? type.join(",") : String(type ?? "")).toLowerCase();
}

/** "£350,000 - £350,000" -> "£350,000" (a single plot's own range always
 * collapses to one real value); "£350,000 - £481,000" (a whole
 * development's range) is left as a genuine range rather than picked
 * apart, since either bound alone would misstate the actual asking price. */
function normalizePriceRange(raw: string): string {
  const parts = raw.split(/\s*-\s*/).map((p) => p.trim());
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  return raw.trim();
}

function priceFromOffers(node: Record<string, unknown>): string | null {
  const offers = node.offers;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (offer && typeof offer === "object") {
    const o = offer as Record<string, unknown>;
    const price = o.price ?? o.lowPrice;
    const currency = typeof o.priceCurrency === "string" ? o.priceCurrency : null;
    if (typeof price === "number") {
      return `${currency === "GBP" || !currency ? "£" : currency}${price.toLocaleString("en-GB")}`;
    }
    if (typeof price === "string" && price.trim() !== "") return price.trim();
  }
  if (typeof node.price === "string" && node.price.trim() !== "") return node.price.trim();
  if (typeof node.price === "number") return `£${(node.price as number).toLocaleString("en-GB")}`;
  if (typeof node.priceRange === "string" && node.priceRange.trim() !== "") {
    return normalizePriceRange(node.priceRange);
  }
  return null;
}

interface JsonLdResult {
  fields: Partial<TrackerExtractedFields>;
  /** Every node's own `name`/`description` string, concatenated — text that
   * schema.org itself says is ABOUT this specific property, as opposed to
   * the page's full rendered text (which also contains nav/footer/"similar
   * homes" filter widgets — confirmed live: a real page's generic "Filter
   * by bedrooms: Studio, 1, 2, 3+" widget text made a blind whole-page
   * regex return "Studio" for a property that was actually 1-bedroom).
   * Used to ground the bedrooms/floor plain-text heuristics below against
   * a much smaller, on-topic blob instead of the whole page. */
  ownText: string;
}

/** Merges every JSON-LD block on the page — first non-null value per field
 * wins, in document order. A single-property page normally has at most one
 * block that states any of these at all (Organization/BreadcrumbList blocks
 * never do), so there's little real ambiguity to resolve. */
function extractFromJsonLd(html: string): JsonLdResult {
  const fields: Partial<TrackerExtractedFields> = {};
  const ownTextParts: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html))) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue; // not valid JSON (e.g. a template placeholder) — skip, never guess at it
    }

    for (const node of flattenJsonLdNodes(data)) {
      const address = node.address;
      if (address && typeof address === "object" && !Array.isArray(address)) {
        const a = address as Record<string, unknown>;
        fields.address ??= firstNonEmptyString(a.streetAddress);
        fields.postcode ??= firstNonEmptyString(a.postalCode);
        fields.area ??= firstNonEmptyString(a.addressLocality);
      }

      fields.price ??= priceFromOffers(node);

      const roomsRaw = node.numberOfRooms ?? node.numberOfBedroomsTotal;
      if (fields.bedrooms == null) {
        if (typeof roomsRaw === "number") fields.bedrooms = String(roomsRaw);
        else if (typeof roomsRaw === "string" && roomsRaw.trim() !== "") fields.bedrooms = roomsRaw.trim();
      }

      // An Organization node (Barratt London, Berkeley Group, etc.) is the
      // one JSON-LD shape that reliably names the developer/builder itself,
      // as opposed to the specific property/branch (LocalBusiness et al).
      if (fields.developer == null && typeNameOf(node) === "organization") {
        fields.developer = firstNonEmptyString(node.name);
      }

      const name = firstNonEmptyString(node.name);
      const description = firstNonEmptyString(node.description);
      if (name) ownTextParts.push(name);
      if (description) ownTextParts.push(description);
    }
  }

  return { fields, ownText: ownTextParts.join(" ") };
}

// ---------- embedded JSON (Next.js __NEXT_DATA__ / common global-state blobs) ----------

const PRICE_KEYS = ["price", "Price", "askingPrice", "guidePrice", "priceGBP"];
const POSTCODE_KEYS = ["postcode", "postCode", "postalCode", "zip"];
const AREA_KEYS = ["area", "town", "locality", "suburb", "district"];
const ADDRESS_KEYS = ["address", "streetAddress", "fullAddress"];
const BEDROOM_KEYS = ["bedrooms", "numberOfBedrooms", "beds", "bedroomCount"];
const FLOOR_KEYS = ["floor", "floorLevel", "floorNumber"];
const DEVELOPER_KEYS = ["developer", "developerName", "builder", "brand"];

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/** True for a plain object that states at least two of our fields directly
 * — enough to trust it's genuinely describing THIS property, not some
 * unrelated config/analytics blob that happens to have a `price` key. */
function looksLikePropertyObject(obj: Record<string, unknown>): boolean {
  let hits = 0;
  for (const keys of [PRICE_KEYS, POSTCODE_KEYS, ADDRESS_KEYS, BEDROOM_KEYS]) {
    if (pickString(obj, keys)) hits++;
  }
  return hits >= 2;
}

function findPropertyObject(root: unknown, maxDepth = 8): Record<string, unknown> | null {
  const visited = new Set<unknown>();
  function walk(node: unknown, depth: number): Record<string, unknown> | null {
    if (depth > maxDepth || node === null || typeof node !== "object" || visited.has(node)) return null;
    visited.add(node);
    if (!Array.isArray(node)) {
      const obj = node as Record<string, unknown>;
      if (looksLikePropertyObject(obj)) return obj;
    }
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return walk(root, 0);
}

/** Same global-state patterns lib/adapters/autoAdapter.ts's embedded-JSON
 * strategy looks for (Next.js/Nuxt/generic app-state blobs), but hunting
 * for one object that plausibly describes THIS single property rather than
 * an array of many listing-like objects. */
function extractFromEmbeddedJson(html: string): Partial<TrackerExtractedFields> {
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

  const fields: Partial<TrackerExtractedFields> = {};
  for (const candidate of candidates) {
    const obj = findPropertyObject(candidate);
    if (!obj) continue;
    fields.price ??= pickString(obj, PRICE_KEYS);
    fields.postcode ??= pickString(obj, POSTCODE_KEYS);
    fields.area ??= pickString(obj, AREA_KEYS);
    fields.address ??= pickString(obj, ADDRESS_KEYS);
    fields.bedrooms ??= pickString(obj, BEDROOM_KEYS);
    fields.floor ??= pickString(obj, FLOOR_KEYS);
    fields.developer ??= pickString(obj, DEVELOPER_KEYS);
  }
  return fields;
}

// ---------- plain-text heuristics (bedrooms/floor stated in prose, not any JSON) ----------

// The digit is required to START with 1-9 (never 0) specifically so this
// can never match a stray trailing "...000" left over when visible-text
// flattening squashes an unrelated number (a price, most often) directly
// up against a later "Bedrooms" label with only a space between them —
// confirmed live: a real page's "...£187,000 Bedrooms 1 Property
// reference..." matched as if "000" were a bedroom count before this fix.
// A genuine count is never written with a leading zero, so this loses
// nothing real.
const BEDROOM_PATTERNS = [/\bstudio\b/i, /\b[1-9][0-9]?\s*-?\s*bed(?:room)?s?\b/i];

/** Matches the page's own wording verbatim (e.g. "1-bedroom", "Studio")
 * rather than reformatting it — kept as the literal matched substring so
 * grounding it back against the same visible text it came from is a
 * triviality, not a coincidence. */
function bedroomsFromText(ownText: string): string | null {
  return matchFirst(BEDROOM_PATTERNS, ownText);
}

// Both patterns require an explicit ordinal suffix ("3rd floor") or the
// word "floor" directly before the digit ("Floor 3") — a bare number
// followed by "floor" with no ordinal is deliberately NOT matched:
// confirmed live that visible-text flattening can squash an unrelated
// number (e.g. a price) right up against a later "Floor Area"/"Floor Plan"
// spec-sheet heading with just a stray space between them, which a looser
// pattern matched as a fabricated floor value. Leading digit restricted to
// 1-9 (never 0) for the same reason as BEDROOM_PATTERNS above — a genuine
// floor number is never written with a leading zero, so this loses nothing
// real while refusing to match a stray "...000" left over from an
// unrelated number squashed against the word "Floor".
const NUMBERED_FLOOR_PATTERNS = [/\b[1-9][0-9]?(?:st|nd|rd|th)\s+floor\b/i, /\bfloor\s+[1-9][0-9]?\b/i];

// "Ground floor"/"Penthouse" carry no number to anchor on, so they're far
// more collision-prone against unrelated context than the numbered
// patterns above — confirmed live: a real HOUSE listing's own spec line
// "Underfloor heating to ground floor" (a feature of the house, not which
// floor a unit sits on — the concept barely even applies to a house)
// matched as if the property itself were "ground floor". Restricted to
// jsonLd.ownText (that node's own name/description — genuinely about THIS
// property) for the same reason BEDROOM_PATTERNS' bare "studio" pattern
// is restricted there, rather than the whole page.
const UNNUMBERED_FLOOR_PATTERNS = [/\bground floor\b/i, /\bpenthouse\b/i];

function matchFirst(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return m[0].trim();
  }
  return null;
}

/** Runs every non-AI strategy (JSON-LD, then embedded JSON, then plain-text
 * heuristics for bedrooms/floor) and merges them — first strategy to find
 * a field wins, since JSON-LD is the most structured/reliable when
 * present. Every returned value is expected to be re-checked with
 * isGrounded() by the caller before being trusted (see
 * lib/trackerExtract.ts) — this function only ever reports what it found,
 * never fabricates.
 *
 * Bedrooms' plain-text heuristic, and floor's UNNUMBERED (ground floor/
 * penthouse) pattern, deliberately search only JSON-LD's own `ownText`
 * (that node's `name`/`description` — genuinely about THIS property),
 * never the whole page's `visibleText`: confirmed live that a real estate
 * site's generic "Filter by bedrooms: Studio, 1, 2, 3+" widget elsewhere on
 * the page made a whole-page search return "Studio" for a property that
 * was actually 1-bedroom, and a real HOUSE listing's own spec line
 * ("Underfloor heating to ground floor" — a feature of the house, not
 * which floor a unit sits on) made a whole-page search return "ground
 * floor" for a property floor doesn't even apply to. Floor's NUMBERED
 * pattern ("Floor 3", "3rd floor") doesn't carry the same collision risk
 * and IS frequently stated only in the page's general body text rather
 * than in any JSON-LD field, so it keeps searching the whole page. */
export function extractStructuredFields(html: string, visibleText: string): Partial<TrackerExtractedFields> {
  const jsonLd = extractFromJsonLd(html);
  const embedded = extractFromEmbeddedJson(html);
  const fields: Partial<TrackerExtractedFields> = {
    price: jsonLd.fields.price ?? embedded.price ?? null,
    address: jsonLd.fields.address ?? embedded.address ?? null,
    postcode: jsonLd.fields.postcode ?? embedded.postcode ?? null,
    area: jsonLd.fields.area ?? embedded.area ?? null,
    bedrooms: jsonLd.fields.bedrooms ?? embedded.bedrooms ?? bedroomsFromText(jsonLd.ownText),
    floor:
      jsonLd.fields.floor ??
      embedded.floor ??
      matchFirst(NUMBERED_FLOOR_PATTERNS, visibleText) ??
      matchFirst(UNNUMBERED_FLOOR_PATTERNS, jsonLd.ownText),
    developer: jsonLd.fields.developer ?? embedded.developer ?? null,
  };
  return fields;
}
