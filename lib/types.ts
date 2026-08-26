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
  /** True when this source's most recent run had a removal the drop guard
   * (lib/dropGuard.ts) rejected as abnormal — its existing listings were
   * preserved rather than removed. See GET /api/health for the site-wide
   * version of this same flag. */
  dropGuardTriggered: boolean;
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

/** One source's result within one sync run — supabase/migrations/0012_sync_run_log.sql
 * (sync_run_source_log). `listingsFound` doubles as "kept": the number of
 * this source's listings that were active at the end of this run
 * (added + updated). */
export interface SyncRunSourceLog {
  sourceId: string;
  sourceName: string;
  status: StoredSourceStatus;
  listingsFound: number;
  added: number;
  updated: number;
  removed: number;
  dedupedCount: number;
  durationMs: number | null;
  ranAt: string;
}

/** One whole sync run — supabase/migrations/0012_sync_run_log.sql
 * (sync_runs_log) plus its sources from sync_run_source_log. `finishedAt`/
 * `totalActiveCount` are both null while the run is still in progress, or
 * if it crashed before finishSyncRunLog() ever ran (lib/syncRunLog.ts) —
 * shown as "incomplete" rather than guessed. */
export interface SyncRunLog {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string;
  totalActiveCount: number | null;
  sources: SyncRunSourceLog[];
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
  /** Real coordinates derived from `postcode` via postcodes.io
   * (lib/geocoding.ts) — null when there's no postcode, or postcodes.io
   * didn't recognise it. Never guessed. */
  lat?: number | null;
  lng?: number | null;
  /** The real station nearest to `lat`/`lng`, with its real straight-line
   * distance (lib/nearestStation.ts) — null whenever `lat`/`lng` is null,
   * never a guessed station. */
  nearestStation?: { name: string; distanceMiles: number } | null;
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

/** GET /api/health's overall verdict. "green" only when every one of
 * lib/dropGuard.ts's checks passes; "red" the moment any one doesn't —
 * see that route's own doc comment for the exact conditions. */
export type HealthStatus = "green" | "red";

export interface HealthResponse {
  status: HealthStatus;
  /** Short, human-readable reasons behind `status` — always at least one
   * entry, green or red (e.g. "Last sync OK, 1,477 listings" when green). */
  reasons: string[];
  /** True only for a red condition a human has to resolve (currently: the
   * drop guard triggered) — as opposed to a red condition later syncs can
   * resolve on their own (a source that's merely gone stale, say). Drives
   * the health sign's distinct "needs my attention" styling. */
  needsAttention: boolean;
  totalActive: number;
  dropGuardActive: boolean;
  dropGuardMessage: string | null;
  dropGuardTriggeredAt: string | null;
  /** Registered sources with zero active listings right now — the exact
   * shape of the 2026-08-25 incident this whole feature set exists
   * because of. Empty in the normal case. */
  emptySources: { sourceId: string; sourceName: string }[];
}

/** One row from sync_events_log (supabase/migrations/0013_reliability.sql)
 * — an audit entry for an automatic action the sync machinery took
 * without a human clicking a button. See lib/dropGuard.ts's logSyncEvent
 * (the only writer) and GET /api/sync-events (the only reader). */
export interface SyncEvent {
  id: string;
  createdAt: string;
  eventType: "drop_guard_rejected" | "auto_retry" | "auto_lock_clear";
  sourceId: string | null;
  message: string;
  details: Record<string, unknown> | null;
}
