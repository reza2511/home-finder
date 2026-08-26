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
import { recordSourceRunLog } from "./syncRunLog";
import { logSyncEvent } from "./dropGuard";
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
  drop_guard_triggered: boolean;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One short pause before runOne's own single auto-retry (see its `attempt`
// param below) — long enough to ride out a fresh network hiccup or a
// browser-crash-and-relaunch, not a real recovery wait. Same value
// scripts/run-sync.ts's own per-source retry used to use before this
// moved to the correct layer — see that script's file header for the
// change and why duplicating a second retry loop there would risk
// retrying a source twice over for one transient blip.
const AUTO_RETRY_DELAY_MS = 5_000;

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

/** `runId` ties every source's row in sync_run_source_log
 * (lib/syncRunLog.ts) back to the one sync_runs_log header row for the
 * whole run it's part of — see runAllAdapters's own doc comment for why
 * that's a wider scope than "one runAllAdapters() call" for
 * scripts/run-sync.ts specifically. Omitted (undefined) skips history
 * logging entirely rather than inventing a run id — every current caller
 * always supplies one; this is just so a stray future caller degrades
 * gracefully instead of throwing.
 *
 * `attempt` (default 1) is what caps the 2026-08-25 safe-self-healing
 * auto-retry at exactly one extra try, later in this same call chain — see
 * the retry branch in the catch block below. Never set by an external
 * caller; it only ever advances via this function calling itself once. */
async function runOne(adapter: SourceAdapter, runId?: string, attempt: number = 1): Promise<void> {
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

    if (attempt > 1) {
      await logSyncEvent(
        "auto_retry",
        adapter.id,
        `Auto-retry succeeded for ${adapter.id} on attempt ${attempt}.`
      );
    }

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
      // The fetch itself succeeded (hence `status` above), but the drop
      // guard (lib/dropGuard.ts) may still have refused to apply this
      // source's removal — surfacing that here, on an otherwise-`ok` row,
      // is deliberate: it's real information about this run, not an error
      // in the adapter. drop_guard_triggered (below) is the precise,
      // structured signal GET /api/health reads; this is just this row's
      // own human-readable note.
      error_message: diff.dropGuardTriggered
        ? "Drop guard rejected this run's removal — existing listings preserved. See sync_events_log / Status Monitor auto-actions for detail."
        : null,
      extraction_method: result.extractionMethod ?? null,
      deduped_count: dedupedCount,
      drop_guard_triggered: diff.dropGuardTriggered,
    });
    if (runId) {
      await recordSourceRunLog(runId, {
        sourceId: adapter.id,
        sourceName: adapter.name,
        status,
        listingsFound: listingsToStore.length,
        added: diff.added,
        updated: diff.updated,
        removed: diff.removed,
        dedupedCount,
        durationMs,
      });
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const { status, httpStatus, message } = classifyFailure(err);

    // Safe self-healing, ONE retry, later in this same call chain — never a
    // loop, never re-running the whole sync, just this one source: a
    // genuinely transient-looking failure (classifyFailure's 'error'
    // bucket — a timeout, a browser crash, a single unexpected 5xx/network
    // error) gets exactly one more try after a short pause. Deliberately
    // NOT retried: 'blocked' (a real bot-detection signal — hammering it
    // again immediately is pointless and can make rate-limiting worse) and
    // 'not_built' (a stub that always throws by design — a retry can only
    // ever fail identically). `attempt === 1` is what caps this at exactly
    // one extra try — the recursive call below always passes attempt + 1,
    // so a second failure falls straight through to recording it below.
    if (status === "error" && attempt === 1) {
      await logSyncEvent(
        "auto_retry",
        adapter.id,
        `Transient-looking error on first attempt for ${adapter.id} (${message}) — retrying once.`,
        { firstAttemptMessage: message, firstAttemptHttpStatus: httpStatus }
      );
      await delay(AUTO_RETRY_DELAY_MS);
      return runOne(adapter, runId, attempt + 1);
    }

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
      error_message: attempt > 1 ? `${message} (after 1 auto-retry)` : message,
      extraction_method: null,
      deduped_count: 0,
      drop_guard_triggered: false,
    });
    if (runId) {
      await recordSourceRunLog(runId, {
        sourceId: adapter.id,
        sourceName: adapter.name,
        status,
        listingsFound: 0,
        added: 0,
        updated: 0,
        removed: 0,
        dedupedCount: 0,
        durationMs,
      });
    }
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
 * already in Supabase to correctly drop duplicates.
 *
 * Every adapter — direct or second-phase — now runs SEQUENTIALLY, one at a
 * time, never Promise.all'd against another. Two reasons stacked on top of
 * each other:
 *   1. (2026-08, second-phase only, originally) dedupeAgainstActiveListings
 *      checks a second-phase source's listings against every OTHER
 *      second-phase source too, not just direct developers (e.g. the two
 *      Benhams pages against each other). That only works if each one
 *      fully finishes (including its own write to Supabase) before the
 *      next one's dedupe query runs — concurrent second-phase sources
 *      would let two overlapping dedupe queries race each other's writes
 *      and silently keep both copies of the same real listing.
 *   2. (2026-08-24, extended to direct-developer adapters too) each
 *      adapter now launches and closes its own dedicated Playwright
 *      browser (lib/adapters/browser.ts's withBrowser()) rather than
 *      sharing one — full isolation between sources either way, but
 *      running every Playwright-based adapter one at a time instead of
 *      several concurrently also keeps this from launching a pile of
 *      simultaneous Chromium processes on a resource-capped runner, on top
 *      of being the simpler, more predictable model now that lib/
 *      syncLock.ts guarantees only one whole sync is running at all —
 *      speed was the only reason for concurrency here, and reliability
 *      matters more.
 * The real cost is a longer total runtime (nothing here is parallelized
 * anymore); accepted as the price of correct cross-source dedup and of a
 * collision in one source never being able to cascade into others.
 *
 * Refresh history (lib/historyStore.ts) is no longer tied to a sync run at
 * all — it's captured on a fixed daily schedule (Vercel Cron) or on demand
 * (the "Capture history now" button), independent of when/whether a sync
 * happens to run.
 *
 * `runId` (lib/syncRunLog.ts) is deliberately a caller-supplied value, not
 * generated in here: scripts/run-sync.ts calls this once PER SOURCE (see
 * its own file header for why), but every one of those calls is still part
 * of the same logical sync run for history purposes — generating a fresh
 * id per call would fragment one real run into 18 separate history entries
 * instead of one with 18 sources under it. Both real callers
 * (scripts/run-sync.ts, app/api/sync/route.ts) generate exactly one id via
 * startSyncRunLog() before their own loop/call and pass it through every
 * invocation; omitted entirely, history logging is just skipped rather than
 * inventing a run id no one asked for.
 *
 * `prune` (default true) gates the pruneUnknownSources() call below — the
 * only code in this app that ever hard-deletes `listings`/`sync_status`
 * rows (lib/db.ts). 2026-08-25: a full "Run sync now" request on Vercel
 * timed out mid-run (all 18 sources, several Playwright-based, sequenced
 * one at a time, easily exceeds the platform's per-request duration cap)
 * and got hard-killed — its own `finally` (releasing lib/syncLock.ts's
 * lock) never ran, and the incident this was traced back to had this same
 * shape: something deleting rows for sources a run never even reached.
 * scripts/run-sync.ts (the GitHub Actions daily cron) has no such
 * request-duration ceiling — a run there either completes or the workflow's
 * own generous timeout-minutes fires — so it's the one caller that keeps
 * pruning on its default. app/api/sync/route.ts explicitly passes `false`:
 * a browser-triggered request can be killed by the platform at any moment
 * outside anyone's control, so it must never be the thing holding a
 * destructive DELETE. Nothing is lost by this split — every valid source
 * still gets pruned once a day by the cron; an unknown source's rows just
 * don't get cleaned up mid-day by a manual click anymore, which was never
 * the point of that button anyway. */
export async function runAllAdapters(
  sourceIds?: string[],
  runId?: string,
  prune: boolean = true
): Promise<void> {
  if (prune) await pruneUnknownSources();
  const targets = sourceIds ? adapters.filter((a) => sourceIds.includes(a.id)) : adapters;
  const directTargets = targets.filter((a) => !isSecondPhaseSource(a.id));
  const secondPhaseTargets = targets.filter((a) => isSecondPhaseSource(a.id));

  for (const adapter of directTargets) {
    await runOne(adapter, runId);
  }
  for (const adapter of secondPhaseTargets) {
    await runOne(adapter, runId);
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
