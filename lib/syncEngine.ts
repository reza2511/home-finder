import { pruneUnknownSources, requireSupabaseAdmin } from "./db";
import { adapters } from "./adapters";
import { isAggregatorSource } from "./developers";
import { recordSyncRunStart } from "./historyStore";
import {
  AdapterAutoExtractionError,
  AdapterHttpError,
  AdapterNotBuiltError,
  SourceAdapter,
} from "./adapters/types";
import { isBotBlockSignal } from "./adapters/blockDetection";
import { applySharedOwnershipOverride } from "./adapters/tenureDetection";
import { dedupeAgainstDirectListings } from "./adapters/dedupe";
import { upsertListingsForSource } from "./listingsStore";
import type { StoredSourceStatus } from "./types";

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
const ADAPTER_TIMEOUT_MS = 900_000;

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
    // in one place, rather than trusting each adapter's own tenure logic
    // individually — see applySharedOwnershipOverride's own doc comment.
    const normalizedListings = result.listings.map((listing) =>
      applySharedOwnershipOverride(listing, adapter.id)
    );

    // Aggregator sources (1newhomes, Benhams) only ever keep listings not
    // already covered by a direct-developer source — see dedupe.ts. Direct
    // developer sources skip this entirely (sourceType check is cheap and
    // dedupeAgainstDirectListings would just be a no-op filter against
    // itself otherwise). runAllAdapters() below always finishes every
    // direct-developer adapter before starting any aggregator one, so this
    // query sees the complete, freshly-synced set of direct listings.
    const isAggregator = isAggregatorSource(adapter.id);
    let dedupedCount = 0;
    let listingsToStore = normalizedListings;
    if (isAggregator) {
      const dedupe = await dedupeAgainstDirectListings(normalizedListings);
      listingsToStore = dedupe.kept;
      dedupedCount = dedupe.droppedCount;
      if (dedupedCount > 0) {
        console.warn(
          `[syncEngine] ${adapter.id}: dropped ${dedupedCount} listing(s) already covered by a direct ` +
            `developer source: ${dedupe.droppedTitles.slice(0, 10).join(", ")}${dedupedCount > 10 ? ", ..." : ""}`
        );
      }
    }

    const diff = await upsertListingsForSource(
      adapter.id,
      listingsToStore,
      isAggregator ? "aggregator" : "developer"
    );
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
 * Direct-developer adapters always run to completion BEFORE any aggregator
 * adapter starts (two sequential phases, not one big Promise.all) — dedupe.ts
 * needs the complete, freshly-synced set of direct listings already in
 * Supabase to correctly drop aggregator duplicates; running everything
 * concurrently would let an aggregator's dedupe query race a direct
 * source's write and silently miss real duplicates.
 *
 * A *full* run (no `sourceIds` — i.e. every source) also records a
 * `sync_runs` row for the refresh-history feature (lib/historyStore.ts): a
 * targeted `?ids=` retry of a handful of sources isn't "a sync" in the
 * sense the history sidebar means, so it's deliberately excluded. */
export async function runAllAdapters(sourceIds?: string[]): Promise<void> {
  await pruneUnknownSources();
  if (!sourceIds) {
    await recordSyncRunStart();
  }
  const targets = sourceIds ? adapters.filter((a) => sourceIds.includes(a.id)) : adapters;
  const directTargets = targets.filter((a) => !isAggregatorSource(a.id));
  const aggregatorTargets = targets.filter((a) => isAggregatorSource(a.id));

  await Promise.all(directTargets.map((adapter) => runOne(adapter)));
  await Promise.all(aggregatorTargets.map((adapter) => runOne(adapter)));
}
