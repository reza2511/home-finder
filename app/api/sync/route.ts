import { NextResponse } from "next/server";
import { runAllAdapters } from "@/lib/syncEngine";
import { isAuthenticated } from "@/lib/auth";
import { acquireSyncLock, releaseSyncLock, lockedMessage } from "@/lib/syncLock";
import { startSyncRunLog, finishSyncRunLog } from "@/lib/syncRunLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Browser-based adapters are slow (Playwright render + price-selector wait
// per source, see ADAPTER_TIMEOUT_MS in lib/syncEngine.ts) — the Vercel
// default of 10s is nowhere near enough. 300s is this route's own ask; the
// value that actually applies is capped by the Vercel plan (Hobby: 60s max,
// can't be raised past that; Pro: up to 300s by default, up to 800s with
// Fluid Compute enabled).
//
// 2026-08-25: this used to also be the route a "sync everything" request
// went through in ONE call — 18 sources, several Playwright-based,
// sequenced strictly one at a time (see runAllAdapters's own doc comment
// for why) — which reliably exceeded whatever duration cap actually
// applied, and Vercel hard-killed the request outright (504 Runtime
// Timeout) partway through, well before it ever finished. That's a
// straightforward request-size problem, not something a bigger timeout
// value fixes: the platform's own cap is a plan-level ceiling this route
// can ask above but never actually raise. MAX_IDS_PER_REQUEST below turns
// that "will definitely time out on a full run" failure into an explicit,
// caught 400 instead — the client (lib/statusClient.ts's triggerSync) now
// drives the exact one-source-per-request sequencing scripts/run-sync.ts
// already uses for the GitHub Actions cron (see that script's own `main()`
// loop), just over HTTP calls instead of a local one; this route enforces
// the cap so nothing can regress back into requesting everything in one
// shot (including a stray future caller, not just the current UI).
export const maxDuration = 300;

const MAX_IDS_PER_REQUEST = 1;

// A request that's about to blow through Vercel's own duration limit gets
// hard-killed by the platform before it ever reaches this route's own
// try/finally — so releaseSyncLock() never runs and the lock would
// otherwise sit there for lib/syncLock.ts's full 6-hour staleness window,
// sized for the GitHub Actions cron's legitimate multi-hour worst case, not
// a single browser-triggered request. This route's own real worst case is
// one source's ADAPTER_TIMEOUT_MS (15 min) plus this route's own
// maxDuration headroom — 20 minutes covers that with margin, so a killed
// manual request self-heals in minutes instead of hours.
const MANUAL_STALE_LOCK_MS = 20 * 60 * 1000;

// Triggers a manual sync of exactly one source adapter (?ids=some-id — see
// MAX_IDS_PER_REQUEST above for why this route no longer accepts more than
// one at a time). In production this same function would also be invoked
// on a 12h schedule (cron / queue worker); here it's exposed so the Status
// Monitor's "Run sync now" button can trigger it on demand, one source per
// request, exactly like scripts/run-sync.ts's own loop.
// Real server-side auth gate, not a front-end nicety — a request with no
// valid session cookie is rejected here regardless of what the UI does or
// doesn't show. See lib/auth.ts.
export async function POST(request: Request) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in to run a sync." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get("ids");
  const ids = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  if (!ids || ids.length === 0) {
    return NextResponse.json(
      { error: "POST /api/sync requires ?ids=a,b,c — a full unbounded sync from this route always ends up exceeding Vercel's request duration limit. Use scripts/run-sync.ts (the GitHub Actions daily cron) for a full sync." },
      { status: 400 }
    );
  }
  if (ids.length > MAX_IDS_PER_REQUEST) {
    return NextResponse.json(
      { error: `POST /api/sync accepts exactly one source id per request via ?ids= (got ${ids.length}) — a bigger batch risks exceeding Vercel's request duration limit mid-run. Call it once per source instead.` },
      { status: 400 }
    );
  }

  // Only one sync (this button, or the GitHub Actions daily run) may ever
  // run at once — see lib/syncLock.ts's own doc comment for why: two
  // overlapping syncs previously raced on the same in-process Playwright
  // browser and crashed each other mid-run. A second click (or a click
  // while the scheduled run is in progress) is rejected outright rather
  // than queued or run concurrently. MANUAL_STALE_LOCK_MS (not the default
  // 6h) is what lets this specific lock self-heal quickly if this very
  // request is the one that ends up killed by the platform.
  const lock = await acquireSyncLock("vercel-manual", MANUAL_STALE_LOCK_MS);
  if (!lock.acquired) {
    return NextResponse.json({ error: lockedMessage(lock.heldBy) }, { status: 409 });
  }

  const startedAt = Date.now();
  // One run id for this whole POST — a single runAllAdapters() call here
  // (unlike scripts/run-sync.ts's own once-per-source loop), so this is the
  // simple case: start the history header row, run this small batch, close
  // it out. `runId` is only assigned once startSyncRunLog() actually
  // succeeds — it throws on failure (lib/syncRunLog.ts), so the `if (runId)`
  // in `finally` below is what keeps that failure from skipping the lock
  // release; finishSyncRunLog() itself is already best-effort internally.
  //
  // prune=false: this route never runs pruneUnknownSources() — see
  // runAllAdapters's own doc comment for why a request the platform can
  // kill at any moment must never be the thing holding that delete.
  let runId: string | null = null;
  try {
    runId = await startSyncRunLog("vercel-manual");
    await runAllAdapters(ids, runId, false);
  } finally {
    if (runId) await finishSyncRunLog(runId);
    await releaseSyncLock(lock.token);
  }
  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sources: ids,
  });
}
