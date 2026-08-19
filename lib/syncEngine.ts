import { pruneUnknownSources, requireSupabaseAdmin } from "./db";
import { adapters } from "./adapters";
import {
  AdapterAutoExtractionError,
  AdapterHttpError,
  AdapterNotBuiltError,
  SourceAdapter,
} from "./adapters/types";
import { isBotBlockSignal } from "./adapters/blockDetection";
import { applySharedOwnershipOverride } from "./adapters/tenureDetection";
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

    const diff = await upsertListingsForSource(adapter.id, normalizedListings);
    const status: StoredSourceStatus =
      normalizedListings.length === 0 ? "no_results" : "ok";

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
      listings_found: normalizedListings.length,
      added: diff.added,
      updated: diff.updated,
      removed: diff.removed,
      duration_ms: durationMs,
      error_message: null,
      extraction_method: result.extractionMethod ?? null,
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
    });
  }
}

/** Runs every registered adapter (or, if `sourceIds` is given, just those),
 * recording one sync_status row per source. Targeting specific sources
 * avoids re-queuing everything behind a shared render-concurrency limit when
 * only a few sources need a retry. */
export async function runAllAdapters(sourceIds?: string[]): Promise<void> {
  await pruneUnknownSources();
  const targets = sourceIds ? adapters.filter((a) => sourceIds.includes(a.id)) : adapters;
  await Promise.all(targets.map((adapter) => runOne(adapter)));
}
