// Raw outcome recorded by the sync engine at the end of an adapter run.
// `stale` is never stored — it is derived at read time (see lib/statusDerive.ts).
// `not_built` means the adapter has no real scraping logic yet (a stub) —
// distinct from `error`, which is reserved for a real adapter that actually
// tried and failed (network, parse, block).
export type StoredSourceStatus = "ok" | "no_results" | "blocked" | "error" | "not_built";

// Effective status shown to clients, after the read-time `stale` derivation.
export type SourceStatus = StoredSourceStatus | "stale";

export interface SyncStatusRow {
  sourceId: string;
  sourceName: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  /** Effective status: raw status, unless the source has gone quiet for >26h. */
  status: SourceStatus;
  /** The status as actually recorded by the last run, before staleness derivation. */
  storedStatus: StoredSourceStatus;
  httpStatus: number | null;
  listingsFound: number;
  added: number;
  updated: number;
  removed: number;
  durationMs: number | null;
  errorMessage: string | null;
  /** Which extraction strategy succeeded, e.g. "json-ld", "html-heuristic",
   * "custom-adapter" — null on failure or if the adapter didn't report one. */
  extractionMethod: string | null;
}

export interface StatusSummary {
  ok: number;
  no_results: number;
  blocked: number;
  error: number;
  stale: number;
  not_built: number;
  total: number;
}

export interface StatusResponse {
  sources: SyncStatusRow[];
  summary: StatusSummary;
}

export type TenureValue = "share_of_freehold" | "leasehold" | "freehold" | "shared_ownership";
export type BedroomTypeValue = "single" | "double" | null;

export interface Listing {
  sourceId: string;
  sourceName: string;
  externalId: string;
  title: string;
  price: string;
  priceValue: number;
  /** Full published price range (e.g. "£680,000 - £2,275,000"), when the
   * source actually states an upper bound — not just a "from" floor.
   * Absent/null when only a single starting price is published. */
  priceRange?: string | null;
  url: string;
  images: string[];
  mainImage: string | null;
  /** Null when the source doesn't state a bedroom count — never guessed. */
  bedrooms: number | null;
  bedroomType: BedroomTypeValue;
  /** Null when the source doesn't publish tenure — never guessed. */
  tenure: TenureValue | null;
  isNewBuild: boolean;
  postcode: string;
  area: string;
}
