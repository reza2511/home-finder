import { pruneUnknownSources, requireSupabaseAdmin } from "./db";
import { adapters } from "./adapters";
import { isAggregatorSource, isEstateAgentSource, isSecondPhaseSource } from "./developers";
import {
  AdapterAutoExtractionError,
  AdapterHttpError,
  AdapterNotBuiltError,
  SourceAdapter,
} from "./adapters/types";
import { isBotBlockSignal } from "./adapters/blockDetection";
import { applySharedOwnershipOverride } from "./adapters/tenureDetection";
import { applyNewBuildOverride } from "./adapters/newBuildDetection";
import { dedupeAgainstActiveListings } from "./adapters/dedupe";
import { upsertListingsForSource } from "./listingsStore";
import { captureDailyStatsSnapshot } from "./statsStore";
import type { SourceType, StoredSourceStatus } from "./types";

// Some adapters make several real, sequential HTTP requests (Barratt London:
// one per development page) or spin up a Playwright render (the generic
// auto-adapter, for JS-rendered/blocked sites — now attempted for almost
// every failing source, and queued behind a small concurrency limit across
// up to ~40 sources at once). A single Playwright render can itself take up
// to ~90s (60s goto + 30s price-selector wait), retries once on timeout
// (up to ~180s), and a page with no listings always burns the full 30s
// price-wait before giving up — plus AI extraction (up to 45s) and queueing.
// A source currently in `error` status also runs URL discovery first (two
// plain fetches, then up to 3 candidate URLs each through this same
// fetch/Playwright/AI pipeline) before falling back to the original
// listings_url — see createAutoAdapter in adapters/autoAdapter.ts — so its
// worst case is several times a single attempt's, not just one.
//
// Exported so scripts/run-sync.ts can size its own outer, script-level
// per-source timeout relative to this one (a generous buffer above it,
// not a competing shorter value) — see that file for why a second timeout
// layer exists at all.
export const ADAPTER_TIMEOUT_MS = 900_000;

interface SyncStatusUpsertRow {
  source_id: string;
  source_name: string;
  last_run_at: string;
  last_success_at: string | null;
  status: StoredSourceStatus;
  http_status: number | null;
  listings_found: number;
  added: number;
  updated: number;
  removed: number;
  duration_ms: number;
  error_message: string | null;
  extraction_method: string | null;
  deduped_count: number;
}

async function upsertSyncStatus(row: SyncStatusUpsertRow): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { error } = await admin.from("sync_status").upsert(row, { onConflict: "source_id" });
  if (error) {
    throw new Error(`upsertSyncStatus(${row.source_id}): write failed: ${error.message}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function classifyFailure(err: unknown): {
  status: "blocked" | "error" | "not_built";
  httpStatus: number | null;
  message: string;
} {
  if (err instanceof AdapterNotBuiltError) {
    return { status: "not_built", httpStatus: null, message: err.message };
  }
  if (err instanceof AdapterAutoExtractionError) {
    // Genuinely attempted extraction (fetch + one or more real strategies)
    // and failed — always `error`, never `not_built`. The reason code and
    // the list of methods tried are already embedded in err.message.
    return { status: "error", httpStatus: null, message: err.message };
  }
  if (err instanceof AdapterHttpError) {
    const blocked = isBotBlockSignal(err.httpStatus, err.body ?? err.message);
    return {
      status: blocked ? "blocked" : "error",
      httpStatus: err.httpStatus,
      message: err.message,
    };
  }
  if (err instanceof Error) {
    return { status: "error", httpStatus: null, message: err.message };
  }
  return { status: "error", httpStatus: null, message: String(err) };
}

async function previousLastSuccessAt(sourceId: string): Promise<string | null> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("sync_status")
    .select("last_success_at")
    .eq("source_id", sourceId)
    .maybeSingle<{ last_success_at: string | null }>();
  if (error) {
    // Best-effort lookup for an already-failing run's own status write —
    // never let a read hiccup here mask the real adapter failure being
    // recorded below.
    console.warn(`[syncEngine] previousLastSuccessAt(${sourceId}): read failed: ${error.message}`);
    return null;
  }
  return data?.last_success_at ?? null;
}

async function runOne(adapter: SourceAdapter): Promise<void> {
  const startedAt = Date.now();
  const lastRunAt = new Date().toISOString();

  try {
    const result = await withTimeout(adapter.run(), ADAPTER_TIMEOUT_MS);
    const durationMs = Date.now() - startedAt;

    // Post-adapter normalization: applied to every source's listings here,
    // in one place, rather than trusting each adapter's own tenure/new-build
    // logic individually — see applySharedOwnershipOverride's and
    // applyNewBuildOverride's own doc comments. Errs toward inclusion: a
    // listing only ever gets flagged NOT new build on a real resale signal
    // in its own text, never for lack of one.
    const normalizedListings = result.listings
      .map((listing) => applySharedOwnershipOverride(listing, adapter.id))
      .map((listing) => applyNewBuildOverride(listing));

    // Aggregator sources (1newhomes, Benhams) and general estate-agent
    // sources (Winkworth, Hamptons, Knight Frank, Renowned Homes, Benhams
    // London) only ever keep listings not already covered by another
    // currently-active listing — a direct developer's, or another
    // second-phase source's (e.g. the two Benhams pages against each other)
    // — see dedupe.ts. Direct developer sources skip this entirely (the
    // check is cheap and dedupeAgainstActiveListings would just be a no-op
    // filter against itself otherwise). runAllAdapters() below always
    // finishes every direct-developer adapter before starting any
    // second-phase one, AND runs second-phase sources sequentially (not in
    // parallel), so this query always sees the complete, freshly-synced set
    // of everything that ran before it in this same sync.
    const isSecondPhase = isSecondPhaseSource(adapter.id);
    let dedupedCount = 0;
    let listingsToStore = normalizedListings;
    if (isSecondPhase) {
      const dedupe = await dedupeAgainstActiveListings(normalizedListings, adapter.id);
      listingsToStore = dedupe.kept;
      dedupedCount = dedupe.droppedCount;
      if (dedupedCount > 0) {
        console.warn(
          `[syncEngine] ${adapter.id}: dropped ${dedupedCount} listing(s) already covered by another ` +
            `active listing: ${dedupe.droppedTitles.slice(0, 10).join(", ")}${dedupedCount > 10 ? ", ..." : ""}`
        );
      }
    }

    const sourceType: SourceType = isAggregatorSource(adapter.id)
      ? "aggregator"
      : isEstateAgentSource(adapter.id)
      ? "estate-agent"
      : "developer";

    const diff = await upsertListingsForSource(adapter.id, listingsToStore, sourceType);
    const status: StoredSourceStatus =
      listingsToStore.length === 0 ? "no_results" : "ok";

    // A run that completed without throwing counts as a "successful run" for
    // staleness purposes, whether or not it found any listings — that's
    // exactly what distinguishes `no_results` (ran fine, found nothing) from
    // `stale` (hasn't run/succeeded at all in a while).
    await upsertSyncStatus({
      source_id: adapter.id,
      source_name: adapter.name,
      last_run_at: lastRunAt,
      last_success_at: lastRunAt,
      status,
      http_status: result.httpStatus ?? 200,
      listings_found: listingsToStore.length,
      added: diff.added,
      updated: diff.updated,
      removed: diff.removed,
      duration_ms: durationMs,
      error_message: null,
      extraction_method: result.extractionMethod ?? null,
      deduped_count: dedupedCount,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const { status, httpStatus, message } = classifyFailure(err);

    await upsertSyncStatus({
      source_id: adapter.id,
      source_name: adapter.name,
      last_run_at: lastRunAt,
      last_success_at: await previousLastSuccessAt(adapter.id),
      status,
      http_status: httpStatus,
      listings_found: 0,
      added: 0,
      updated: 0,
      removed: 0,
      duration_ms: durationMs,
      error_message: message,
      extraction_method: null,
      deduped_count: 0,
    });
  }
}

/** Runs every registered adapter (or, if `sourceIds` is given, just those),
 * recording one sync_status row per source. Targeting specific sources
 * avoids re-queuing everything behind a shared render-concurrency limit when
 * only a few sources need a retry.
 *
 * Direct-developer adapters always run to completion BEFORE any second-phase
 * adapter (aggregator or estate-agent — see isSecondPhaseSource) starts —
 * dedupe.ts needs the complete, freshly-synced set of direct listings
 * already in Supabase to correctly drop duplicates. Direct-developer
 * adapters themselves still run concurrently (Promise.all) among each
 * other — they never dedupe against one another, so there's no ordering
 * requirement there.
 *
 * Second-phase adapters, however, run SEQUENTIALLY (one at a time, not
 * Promise.all) — 2026-08: changed from concurrent, because
 * dedupeAgainstActiveListings now checks a second-phase source's listings
 * against every OTHER second-phase source too, not just direct developers
 * (e.g. the two Benhams pages against each other). That only works if each
 * one fully finishes (including its own write to Supabase) before the next
 * one's dedupe query runs — running them concurrently would let two
 * overlapping sources' dedupe queries race each other's writes and silently
 * keep both copies of the same real listing. The real cost is a longer
 * total second-phase runtime (no longer parallelized); accepted as the
 * price of correct cross-source dedup.
 *
 * Refresh history (lib/historyStore.ts) is no longer tied to a sync run at
 * all — it's captured on a fixed daily schedule (Vercel Cron) or on demand
 * (the "Capture history now" button), independent of when/whether a sync
 * happens to run. */
export async function runAllAdapters(sourceIds?: string[]): Promise<void> {
  await pruneUnknownSources();
  const targets = sourceIds ? adapters.filter((a) => sourceIds.includes(a.id)) : adapters;
  const directTargets = targets.filter((a) => !isSecondPhaseSource(a.id));
  const secondPhaseTargets = targets.filter((a) => isSecondPhaseSource(a.id));

  await Promise.all(directTargets.map((adapter) => runOne(adapter)));
  for (const adapter of secondPhaseTargets) {
    await runOne(adapter);
  }

  // Statistics page snapshot (lib/statsStore.ts) — upserts today's UTC-date
  // row with whatever's now active, regardless of whether this call synced
  // every source or just a handful via `sourceIds` (scripts/run-sync.ts
  // calls this once per source, sequentially — see its own file header;
  // each call's upsert just overwrites the same day's row, and by the time
  // that loop's last call runs, every source has been synced at least once
  // today, so the row that survives is still the complete picture). Never
  // lets a capture failure fail the sync itself — best-effort, same as
  // recordRemovedFavourites in lib/listingsStore.ts.
  try {
    await captureDailyStatsSnapshot();
  } catch (err) {
    console.warn(
      `[syncEngine] captureDailyStatsSnapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
