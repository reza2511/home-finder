/**
 * Standalone entry point for running a full sync outside of Next.js and
 * outside a logged-in browser session — used by
 * .github/workflows/daily-sync.yml (GitHub Actions, runs on a schedule
 * independent of any PC being on) and can also be run locally with
 * `npm run sync` (reads .env.local via `node --env-file`, same as
 * scripts/run-migrations.mjs).
 *
 * app/api/sync/route.ts is gated by isAuthenticated() (a browser session
 * cookie) because it's reachable over the public internet. This script
 * calls the same runAllAdapters() directly, in-process, instead — safe
 * here because the only thing that can trigger it is whatever already has
 * access to run this workflow / these secrets, not an anonymous HTTP
 * request.
 *
 * Sequencing: production (app/api/sync/route.ts) runs every direct-
 * developer adapter concurrently (Promise.all) and only second-phase
 * (aggregator/estate-agent) adapters sequentially — see runAllAdapters()'s
 * own doc comment in lib/syncEngine.ts. On a shared GitHub Actions runner
 * (2 vCPUs), running several Playwright Chromium renders at once is a much
 * bigger resource risk than on Vercel, so this script instead calls
 * runAllAdapters() once per source, one at a time — direct-developer
 * adapters first (to completion), then second-phase ones — preserving the
 * same "all direct before any second-phase" ordering runAllAdapters()
 * itself relies on for correct cross-source dedup, just with direct
 * adapters serialized too instead of run via Promise.all.
 *
 * No per-source caps are loosened by this: ADAPTER_TIMEOUT_MS and
 * MAX_CONCURRENT_RENDERS (lib/syncEngine.ts / lib/adapters/autoAdapter.ts)
 * and every adapter's own per-page/per-source limits apply exactly as they
 * do in production — this script only changes the order/concurrency in
 * which sources are handed to the existing runAllAdapters(). It ADDS one
 * extra, script-level per-source timeout on top (OUTER_TIMEOUT_MS below) —
 * see its own comment for why.
 *
 * Process lifetime (2026-08-23): a run that completed all its actual sync
 * work was still taking 90+ minutes in GitHub Actions and hanging instead
 * of exiting — the shared Playwright Chromium instance
 * (lib/adapters/browser.ts's getSharedBrowser(), deliberately never closed
 * by production code, since staying warm across invocations is the point
 * there — see that file's header) keeps a live connection to its browser
 * subprocess open, which keeps Node's event loop alive indefinitely once
 * nothing else is scheduled. Two fixes, both here rather than in
 * browser.ts/syncEngine.ts, so Vercel's production behaviour (which relies
 * on the browser staying warm) is untouched:
 *   1. closeSharedBrowser() in the `finally` below — closes it if the run
 *      ever launched one.
 *   2. An explicit process.exit() call at the very end, after that close
 *      and every DB write have already happened — a backstop in case
 *      anything else (a stray timer, an open socket) would otherwise have
 *      kept the process alive regardless.
 */
import { runAllAdapters, ADAPTER_TIMEOUT_MS } from "../lib/syncEngine";
import { adapters } from "../lib/adapters";
import { isSecondPhaseSource } from "../lib/developers";
import { closeSharedBrowser } from "../lib/adapters/browser";

// The engine's own per-adapter timeout (lib/syncEngine.ts) already bounds
// a single source's run and records a proper `error`/`blocked` sync_status
// row when it fires — this outer timeout is a script-level safety net on
// top of that, not a replacement for it: a generous buffer (2 minutes)
// above ADAPTER_TIMEOUT_MS gives the inner one every chance to fire first
// and record the real reason. It only matters if something bypasses the
// inner timeout entirely (e.g. a native call that ignores its own timeout
// option) — without it, that single source could otherwise hang this
// script forever, since a timed-out *promise* here doesn't cancel whatever
// underlying work it was waiting on; only closeSharedBrowser() (which
// tears down the actual browser subprocess) and the final process.exit()
// can actually force that work to stop.
const OUTER_TIMEOUT_MS = ADAPTER_TIMEOUT_MS + 120_000;

function withOuterTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: exceeded the outer ${ms}ms script-level timeout`)),
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

/** Runs every source and returns the process exit code (0 = every source
 * ran without a script-level error, 1 = at least one didn't). Never throws
 * for a single source's own failure — those are caught and logged so one
 * broken source never blocks the rest of the day's sync. */
async function main(): Promise<number> {
  const direct = adapters.filter((a) => !isSecondPhaseSource(a.id)).map((a) => a.id);
  const secondPhase = adapters.filter((a) => isSecondPhaseSource(a.id)).map((a) => a.id);
  const orderedIds = [...direct, ...secondPhase];

  console.log(`[run-sync] Starting sequential sync of ${orderedIds.length} source(s)...`);

  let failures = 0;
  for (const [index, id] of orderedIds.entries()) {
    const startedAt = Date.now();
    console.log(`[run-sync] (${index + 1}/${orderedIds.length}) ${id} ...`);
    try {
      // A single-element sourceIds array — runAllAdapters() still does its
      // usual pruneUnknownSources() + direct/second-phase classification
      // per call, so each source is written to Supabase (including its own
      // sync_status row) before the loop moves on to the next one.
      await withOuterTimeout(runAllAdapters([id]), OUTER_TIMEOUT_MS, id);
      console.log(`[run-sync] (${index + 1}/${orderedIds.length}) ${id} done in ${Date.now() - startedAt}ms`);
    } catch (err) {
      // Per-adapter failures are normally already caught and recorded in
      // sync_status inside runOne() (lib/syncEngine.ts) and never reach
      // here — a rejection here means either something outside a single
      // adapter failed (e.g. pruneUnknownSources() itself, on bad Supabase
      // credentials), or the outer per-source timeout above fired because
      // the inner one didn't protect us. Either way: log it and keep going
      // so one broken source never blocks the rest of the day's sync, but
      // still fail the workflow run at the end so it's visible in GitHub
      // Actions.
      failures += 1;
      console.error(`[run-sync] (${index + 1}/${orderedIds.length}) ${id} FAILED:`, err);
    }
  }

  console.log(`[run-sync] Sync complete. ${orderedIds.length - failures}/${orderedIds.length} source(s) ran without a script-level error.`);
  return failures > 0 ? 1 : 0;
}

async function run(): Promise<void> {
  let exitCode = 0;
  try {
    exitCode = await main();
  } catch (err) {
    console.error("[run-sync] Fatal error:", err);
    exitCode = 1;
  } finally {
    // Always runs, success or failure — see the file header's "Process
    // lifetime" note for why this (and the process.exit() below) exist.
    await closeSharedBrowser();
    console.log("[run-sync] Closed the shared browser (if one was launched).");
  }

  // All DB writes (including this run's own sync_status/stats rows) have
  // already completed by this point — nothing async is scheduled after
  // this call. Exits immediately instead of waiting for Node to notice
  // there's nothing left keeping the event loop alive on its own.
  process.exit(exitCode);
}

run();
