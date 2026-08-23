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
  /** How many of this run's raw listings were dropped because a
   * direct-developer source already covers them — always 0 for a direct
   * developer source itself; only aggregators (1newhomes, Benhams) ever
   * dedupe. See lib/adapters/dedupe.ts. */
  dedupedCount: number;
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

/** "aggregator" for a listing from a real third-party listing site
 * (1newhomes, Benhams); "estate-agent" for a general estate agent whose
 * stock is predominantly resale, with only genuinely new-build listings
 * kept (Winkworth — see lib/adapters/newBuildDetection.ts's
 * hasExplicitNewBuildSignal); "developer" (the default) for a developer's
 * own site. Surfaced so the UI can label non-direct-developer listings if
 * it ever wants to — dedup itself already happened before storage. */
export type SourceType = "developer" | "aggregator" | "estate-agent";

export interface Listing {
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
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
  /** Absent/null when the source doesn't publish a per-listing bathroom
   * count — never derived from bedroom count or any other proxy. Only a
   * handful of sources currently state this (see lib/adapters/types.ts). */
  bathrooms?: number | null;
  /** Absent/null when the source doesn't publish a per-listing parking
   * count. No current source publishes this — the field exists for when
   * one does, never invented in the meantime. */
  parking?: number | null;
  /** Floor number within the building (0 = ground floor), when the source
   * states one for this specific home — never guessed from a
   * development's overall height, unit numbering, or property type. */
  floor?: number | null;
  /** Null when the source doesn't publish tenure — never guessed. */
  tenure: TenureValue | null;
  isNewBuild: boolean;
  postcode: string;
  area: string;
}

/** A listing that has gone inactive (vanished from its source during a
 * sync — likely sold/withdrawn), for the public Removed items page. Same
 * shape as `Listing` plus `removedAt`: the timestamp of the sync run that
 * first noticed it was gone (lib/listingsStore.ts). Only listings removed
 * since this column started being recorded ever have one — see
 * supabase/migrations/0008_add_listing_removed_at.sql. */
export interface RemovedListing extends Listing {
  removedAt: string;
}
