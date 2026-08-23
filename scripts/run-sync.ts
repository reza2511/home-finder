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
 *
 * Exit code (2026-08-23): a real run reported "17/18 sources ran without a
 * script-level error" and still exited non-zero, failing the whole GitHub
 * Actions run over one source. From the actual log: barratt-london failed
 * 1.3s into the job with "JWT issued at future" thrown from
 * pruneUnknownSources() (lib/db.ts) — a fresh runner VM's system clock
 * occasionally hasn't finished settling/NTP-syncing in its first second,
 * making a real, static token's issued-at briefly look like it's in the
 * future. Every one of the other 17 sources' own pruneUnknownSources()
 * call (each runAllAdapters() call makes its own) succeeded seconds later
 * — nothing was wrong with barratt-london's adapter or URL; its scrape was
 * never even attempted, because the failure happened before runOne() was
 * reached at all. Two changes address this:
 *   1. Each source now gets one retry (after a short delay) before being
 *      logged as failed — enough to ride out exactly this kind of
 *      transient, self-resolving blip.
 *   2. The exit code no longer fails the whole run over a handful of
 *      per-source failures: it only reports failure (1) if EVERY source
 *      failed, the actual signal of something catastrophic (e.g. the
 *      database genuinely unreachable for the whole run) rather than one
 *      source having a bad day. Any real per-source failure is still
 *      logged here AND recorded in that source's own sync_status row
 *      (lib/syncEngine.ts), so it stays fully visible in the Status
 *      Monitor — this only changes whether it fails the CI run itself.
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

// One retry, after a short pause — sized for a transient blip (a fresh
// runner's clock still settling, a momentary network hiccup), not for
// anything that takes real recovery time. A source that fails twice in a
// row is genuinely broken for this run, not just unlucky.
const RETRY_DELAY_MS = 5_000;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs every source and returns the process exit code — 0 unless EVERY
 * source failed (see the file header's "Exit code" note for why that's
 * the actual catastrophic-failure signal, not any single source failing).
 * Never throws for one source's own failure, even after its retry — those
 * are caught and logged so one broken source never blocks the rest of the
 * day's sync. */
async function main(): Promise<number> {
  const direct = adapters.filter((a) => !isSecondPhaseSource(a.id)).map((a) => a.id);
  const secondPhase = adapters.filter((a) => isSecondPhaseSource(a.id)).map((a) => a.id);
  const orderedIds = [...direct, ...secondPhase];

  console.log(`[run-sync] Starting sequential sync of ${orderedIds.length} source(s)...`);

  let failures = 0;
  for (const [index, id] of orderedIds.entries()) {
    const label = `(${index + 1}/${orderedIds.length}) ${id}`;
    const startedAt = Date.now();
    console.log(`[run-sync] ${label} ...`);

    let lastErr: unknown;
    let succeeded = false;
    for (let attempt = 1; attempt <= 2 && !succeeded; attempt++) {
      try {
        // A single-element sourceIds array — runAllAdapters() still does
        // its usual pruneUnknownSources() + direct/second-phase
        // classification per call, so each source is written to Supabase
        // (including its own sync_status row) before the loop moves on.
        await withOuterTimeout(runAllAdapters([id]), OUTER_TIMEOUT_MS, id);
        succeeded = true;
      } catch (err) {
        lastErr = err;
        if (attempt === 1) {
          console.warn(`[run-sync] ${label} attempt 1 failed, retrying in ${RETRY_DELAY_MS}ms:`, err);
          await delay(RETRY_DELAY_MS);
        }
      }
    }

    if (succeeded) {
      console.log(`[run-sync] ${label} done in ${Date.now() - startedAt}ms`);
    } else {
      // Per-adapter (scraper) failures are normally already caught and
      // recorded in sync_status inside runOne() (lib/syncEngine.ts) and
      // never reach here — a rejection here means either something
      // outside a single adapter failed (e.g. pruneUnknownSources()
      // itself, on a transient Supabase/auth hiccup), or the outer
      // per-source timeout above fired because the inner one didn't
      // protect us. Either way, after a retry has already been tried: log
      // it and move on to the next source. See the exit code at the
      // bottom of main() for how this affects the overall run result.
      failures += 1;
      console.error(`[run-sync] ${label} FAILED after retry:`, lastErr);
    }
  }

  const succeededCount = orderedIds.length - failures;
  console.log(`[run-sync] Sync complete. ${succeededCount}/${orderedIds.length} source(s) ran without a script-level error.`);

  // Catastrophic = nothing worked at all (e.g. the database was genuinely
  // unreachable for the whole run) — anything short of that means the
  // sync did its job and wrote real data, so the run reports success.
  const catastrophic = orderedIds.length > 0 && succeededCount === 0;
  return catastrophic ? 1 : 0;
}

async function run(): Promise<void> {
  let exitCode = 0;
  try {
    exitCode = await main();
  } catch (err) {
    // Something failed outside the per-source loop entirely (e.g. the
    // adapter registry itself throwing at import time) — this is the
    // other genuinely catastrophic case, so it still fails the run.
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
