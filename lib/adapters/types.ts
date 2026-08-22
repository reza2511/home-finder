/**
 * Thrown by an adapter when a fetch comes back non-2xx, or when the body it did
 * get back is recognisable as a bot-block/challenge page rather than real content.
 * The sync engine inspects `httpStatus` and `body` to classify the failure as
 * `blocked` vs a plain `error`.
 */
export class AdapterHttpError extends Error {
  httpStatus: number;
  body?: string;

  constructor(message: string, httpStatus: number, body?: string) {
    super(message);
    this.name = "AdapterHttpError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

/**
 * Thrown by a stub adapter (lib/adapters/stub.ts) for a developer that has no
 * real scraping logic yet. The sync engine classifies this as `not_built`,
 * kept distinct from `error` — which is reserved for a real adapter that
 * actually attempted a fetch and failed (network, parse, block).
 */
export class AdapterNotBuiltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterNotBuiltError";
  }
}

export type AutoExtractionFailureReason =
  | "js_required"
  | "no_pattern_found"
  | "parse_error";

/**
 * Thrown by the generic auto-adapter (lib/adapters/autoAdapter.ts) when it
 * genuinely attempted extraction (unlike a stub) but couldn't produce usable
 * listings. Kept distinct from a bot-block (still thrown as AdapterHttpError,
 * classified `blocked`) — this always classifies as `error`, with the reason
 * and the extraction methods tried embedded in the message.
 */
export class AdapterAutoExtractionError extends Error {
  reason: AutoExtractionFailureReason;
  attempted: string[];

  constructor(reason: AutoExtractionFailureReason, detail: string, attempted: string[]) {
    super(`[${reason}] ${detail} (tried: ${attempted.join(", ") || "none"})`);
    this.name = "AdapterAutoExtractionError";
    this.reason = reason;
    this.attempted = attempted;
  }
}

export type TenureValue = "share_of_freehold" | "leasehold" | "freehold" | "shared_ownership";
export type BedroomTypeValue = "single" | "double" | null;

export interface AdapterListing {
  externalId: string;
  title: string;
  price: string;
  /** Numeric GBP value backing the price-range filter. */
  priceValue: number;
  /** Full published price range (e.g. "£430,000 - £900,000"), when the
   * source actually states an upper bound — not just a "from" floor.
   * Absent/null when only a single starting price is published. */
  priceRange?: string | null;
  url: string;
  /** Gallery photo URLs, in display order. Empty when the source has none. */
  images: string[];
  /** Convenience accessor — `images[0]`, or null when there are no photos. */
  mainImage: string | null;
  /** Null when the source doesn't state a bedroom count — never guessed. */
  bedrooms: number | null;
  bedroomType: BedroomTypeValue;
  /** Absent/null when the source doesn't publish a per-listing bathroom
   * count — never derived from bedroom count or any other proxy. Confirmed
   * live (2026-08) as a real structured field on Winkworth, Hamptons (its
   * per-listing detail page), and L&Q. */
  bathrooms?: number | null;
  /** Absent/null when the source doesn't publish a per-listing parking
   * count. No adapter currently populates this — no source checked so far
   * publishes it as a real structured field — left here for a future one
   * that does, never invented in the meantime. */
  parking?: number | null;
  /** Floor number within the building (0 = ground floor), when the source
   * states one for this specific home — never guessed from a
   * development's overall height, unit numbering, or property type.
   * Confirmed live (2026-08) as a real structured field on Berkeley,
   * Fairview New Homes, L&Q, Barratt London, and Redrow. */
  floor?: number | null;
  /** Null when the source doesn't publish tenure — never guessed. */
  tenure: TenureValue | null;
  isNewBuild: boolean;
  postcode: string;
  area: string;
}

export interface AdapterRunResult {
  listings: AdapterListing[];
  httpStatus?: number;
  /** Which extraction strategy produced these listings, e.g. "json-ld",
   * "embedded-json", "html-heuristic", "custom-adapter" — optional,
   * surfaced in the Status Monitor for observability. */
  extractionMethod?: string;
}

export interface SourceAdapter {
  id: string;
  name: string;
  run(): Promise<AdapterRunResult>;
}
