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
 * No per-source caps are touched by this: ADAPTER_TIMEOUT_MS and
 * MAX_CONCURRENT_RENDERS (lib/syncEngine.ts / lib/adapters/autoAdapter.ts)
 * and every adapter's own per-page/per-source limits apply exactly as they
 * do in production — this script only changes the order/concurrency in
 * which sources are handed to the existing runAllAdapters().
 */
import { runAllAdapters } from "../lib/syncEngine";
import { adapters } from "../lib/adapters";
import { isSecondPhaseSource } from "../lib/developers";

async function main() {
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
      await runAllAdapters([id]);
      console.log(`[run-sync] (${index + 1}/${orderedIds.length}) ${id} done in ${Date.now() - startedAt}ms`);
    } catch (err) {
      // Per-adapter failures are already caught and recorded in
      // sync_status inside runOne() (lib/syncEngine.ts) and never reach
      // here. A rejection here means something outside a single adapter
      // failed (e.g. pruneUnknownSources() itself, on bad Supabase
      // credentials) — log it and keep going so one broken source never
      // blocks the rest of the day's sync, but still fail the workflow run
      // at the end so it's visible in GitHub Actions.
      failures += 1;
      console.error(`[run-sync] (${index + 1}/${orderedIds.length}) ${id} FAILED:`, err);
    }
  }

  console.log(`[run-sync] Sync complete. ${orderedIds.length - failures}/${orderedIds.length} source(s) ran without a script-level error.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[run-sync] Fatal error:", err);
  process.exit(1);
});
