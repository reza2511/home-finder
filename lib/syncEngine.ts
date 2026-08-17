import { db } from "./db";
import { adapters } from "./adapters";
import {
  AdapterAutoExtractionError,
  AdapterHttpError,
  AdapterNotBuiltError,
  SourceAdapter,
} from "./adapters/types";
import { isBotBlockSignal } from "./adapters/blockDetection";
import { upsertListingsForSource } from "./listingsStore";
import type { StoredSourceStatus } from "./types";

// Some adapters make several real, sequential HTTP requests (Barratt London:
// one per development page) or spin up a Playwright render (the generic
// auto-adapter, for JS-rendered/blocked sites — now attempted for almost
// every failing source, and queued behind a small concurrency limit across
// up to ~40 sources at once). A single Playwright render can itself take up
// to ~90s (60s goto + 30s price-selector wait), retries once on timeout
// (up to ~180s), and a page with no listings always burns the full 30s
// price-wait before giving up — plus AI extraction (up to 45s) and queueing
// — so a single request's timeout is nowhere near enough headroom.
const ADAPTER_TIMEOUT_MS = 450_000;

const upsertStatusStmt = db.prepare(`
  INSERT INTO sync_status
    (sourceId, sourceName, lastRunAt, lastSuccessAt, status, httpStatus, listingsFound, added, updated, removed, durationMs, errorMessage, extractionMethod)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sourceId) DO UPDATE SET
    sourceName       = excluded.sourceName,
    lastRunAt        = excluded.lastRunAt,
    lastSuccessAt    = excluded.lastSuccessAt,
    status           = excluded.status,
    httpStatus       = excluded.httpStatus,
    listingsFound    = excluded.listingsFound,
    added            = excluded.added,
    updated          = excluded.updated,
    removed          = excluded.removed,
    durationMs       = excluded.durationMs,
    errorMessage     = excluded.errorMessage,
    extractionMethod = excluded.extractionMethod
`);

const getPrevSuccessStmt = db.prepare(
  `SELECT lastSuccessAt FROM sync_status WHERE sourceId = ?`
);

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

function previousLastSuccessAt(sourceId: string): string | null {
  const row = getPrevSuccessStmt.get(sourceId) as unknown as
    | { lastSuccessAt: string | null }
    | undefined;
  return row?.lastSuccessAt ?? null;
}

async function runOne(adapter: SourceAdapter): Promise<void> {
  const startedAt = Date.now();
  const lastRunAt = new Date().toISOString();

  try {
    const result = await withTimeout(adapter.run(), ADAPTER_TIMEOUT_MS);
    const durationMs = Date.now() - startedAt;

    const diff = upsertListingsForSource(adapter.id, result.listings);
    const status: StoredSourceStatus =
      result.listings.length === 0 ? "no_results" : "ok";

    // A run that completed without throwing counts as a "successful run" for
    // staleness purposes, whether or not it found any listings — that's
    // exactly what distinguishes `no_results` (ran fine, found nothing) from
    // `stale` (hasn't run/succeeded at all in a while).
    upsertStatusStmt.run(
      adapter.id,
      adapter.name,
      lastRunAt,
      lastRunAt,
      status,
      result.httpStatus ?? 200,
      result.listings.length,
      diff.added,
      diff.updated,
      diff.removed,
      durationMs,
      null,
      result.extractionMethod ?? null
    );
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const { status, httpStatus, message } = classifyFailure(err);

    upsertStatusStmt.run(
      adapter.id,
      adapter.name,
      lastRunAt,
      previousLastSuccessAt(adapter.id),
      status,
      httpStatus,
      0,
      0,
      0,
      0,
      durationMs,
      message,
      null
    );
  }
}

/** Runs every registered adapter (or, if `sourceIds` is given, just those),
 * recording one sync_status row per source. Targeting specific sources
 * avoids re-queuing everything behind a shared render-concurrency limit when
 * only a few sources need a retry. */
export async function runAllAdapters(sourceIds?: string[]): Promise<void> {
  const targets = sourceIds ? adapters.filter((a) => sourceIds.includes(a.id)) : adapters;
  await Promise.all(targets.map((adapter) => runOne(adapter)));
}
