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
 * Sequencing: runAllAdapters() (lib/syncEngine.ts) itself now runs every
 * adapter — direct-developer or second-phase — strictly one at a time, the
 * same on Vercel (app/api/sync/route.ts) as here; see that function's own
 * doc comment for why. This script calls it once per source anyway (rather
 * than once for the whole list) purely to get an independent retry and an
 * outer, script-level timeout per source (OUTER_TIMEOUT_MS below) — not to
 * impose sequencing that the engine no longer already guarantees on its
 * own.
 *
 * No per-source caps are loosened by this: ADAPTER_TIMEOUT_MS and
 * MAX_CONCURRENT_RENDERS (lib/syncEngine.ts / lib/adapters/autoAdapter.ts)
 * and every adapter's own per-page/per-source limits apply exactly as they
 * do in production — this script only changes the order in which sources
 * are handed to the existing runAllAdapters(). It ADDS one extra, script-
 * level per-source timeout on top (OUTER_TIMEOUT_MS below) — see its own
 * comment for why.
 *
 * Single sync at a time (2026-08-24): the whole run is wrapped in
 * lib/syncLock.ts's DB-backed lock (acquired once here, for the entire
 * run — never per-source, which would leave real gaps between sources for
 * a second sync to slip into) — see that file's own doc comment for the
 * collision it exists to prevent. A run that finds the lock already held
 * (the Vercel button, or a second overlapping GitHub Actions run) logs why
 * and exits 0 immediately rather than running anything — this is an
 * intentional, successful no-op, not a failure.
 *
 * Process lifetime (2026-08-23): a run that completed all its actual sync
 * work was still taking 90+ minutes in GitHub Actions and hanging instead
 * of exiting — the (then-)shared Playwright Chromium instance kept a live
 * connection to its browser subprocess open, which keeps Node's event loop
 * alive indefinitely once nothing else is scheduled. lib/adapters/
 * browser.ts no longer shares one browser across sources at all (see that
 * file's header) — every adapter closes its own the moment it's done —
 * so nothing should be left running by the time this reaches its end
 * regardless. The explicit process.exit() call below stays anyway, as a
 * backstop in case anything else (a stray timer, an open socket) would
 * otherwise keep the process alive.
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
import { acquireSyncLock, releaseSyncLock, lockedMessage } from "../lib/syncLock";
import { startSyncRunLog, finishSyncRunLog } from "../lib/syncRunLog";

// The engine's own per-adapter timeout (lib/syncEngine.ts) already bounds
// a single source's run and records a proper `error`/`blocked` sync_status
// row when it fires — this outer timeout is a script-level safety net on
// top of that, not a replacement for it: a generous buffer (2 minutes)
// above ADAPTER_TIMEOUT_MS gives the inner one every chance to fire first
// and record the real reason. It only matters if something bypasses the
// inner timeout entirely (e.g. a native call that ignores its own timeout
// option) — without it, that single source could otherwise hang this
// script forever, since a timed-out *promise* here doesn't cancel whatever
// underlying work it was waiting on; only that source's own browser being
// closed (lib/adapters/browser.ts's withBrowser(), in its own `finally`)
// and the final process.exit() below can actually force that work to stop.
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
async function main(runId: string): Promise<number> {
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
        await withOuterTimeout(runAllAdapters([id], runId), OUTER_TIMEOUT_MS, id);
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
  // Only one sync — this GitHub Actions run, or the Vercel "Run sync now"
  // button — may ever run at once. See lib/syncLock.ts's own doc comment
  // for the collision this exists to prevent. Acquired ONCE here, for the
  // entire run (every source, not per-source) — see the file header's
  // "Single sync at a time" note for why that scope matters.
  const lock = await acquireSyncLock("github-actions");
  if (!lock.acquired) {
    console.log(`[run-sync] Skipping this run — ${lockedMessage(lock.heldBy)}`);
    process.exit(0);
  }

  let exitCode = 0;
  // One run id for the whole script execution, even though main() below
  // calls runAllAdapters() once per source — see that function's own doc
  // comment for why a per-source id would be wrong here. Not wrapped in the
  // same best-effort try/catch as finishSyncRunLog below: startSyncRunLog()
  // deliberately throws on failure (lib/syncRunLog.ts), and a run with no
  // history header row to attach source rows to is treated the same as any
  // other fatal error that happens before main() gets going.
  let runId: string | null = null;
  try {
    runId = await startSyncRunLog("github-actions");
    exitCode = await main(runId);
  } catch (err) {
    // Something failed outside the per-source loop entirely (e.g. the
    // adapter registry itself throwing at import time) — this is the
    // other genuinely catastrophic case, so it still fails the run.
    console.error("[run-sync] Fatal error:", err);
    exitCode = 1;
  } finally {
    // Best-effort on top of finishSyncRunLog's own internal best-effort
    // handling — never let a history-logging hiccup stop the lock from
    // being released below.
    if (runId) {
      try {
        await finishSyncRunLog(runId);
      } catch (err) {
        console.warn("[run-sync] finishSyncRunLog failed (non-fatal):", err);
      }
    }
    await releaseSyncLock(lock.token);
  }

  // All DB writes (including this run's own sync_status/stats rows) have
  // already completed by this point — nothing async is scheduled after
  // this call. Exits immediately instead of waiting for Node to notice
  // there's nothing left keeping the event loop alive on its own.
  process.exit(exitCode);
}

run();
