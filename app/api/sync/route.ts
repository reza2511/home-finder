import { NextResponse } from "next/server";
import { runAllAdapters } from "@/lib/syncEngine";
import { isAuthenticated } from "@/lib/auth";
import { acquireSyncLock, releaseSyncLock, lockedMessage } from "@/lib/syncLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Browser-based adapters are slow (Playwright render + price-selector wait
// per source, see ADAPTER_TIMEOUT_MS in lib/syncEngine.ts) — the Vercel
// default of 10s is nowhere near enough. 300s is this route's own ask; the
// value that actually applies is capped by the Vercel plan (Hobby: 60s max,
// can't be raised past that; Pro: up to 300s by default, up to 800s with
// Fluid Compute enabled) — see the deployment notes for what that means for
// syncing every source in one request versus a few `?ids=` at a time.
export const maxDuration = 300;

// Triggers a manual sync of every registered source adapter (or, with
// ?ids=a,b,c, just those — useful for retrying a handful of sources without
// re-queuing everything behind the shared Playwright render-concurrency
// limit). In production this same function would also be invoked on a 12h
// schedule (cron / queue worker); here it's exposed so the Status Monitor's
// "Run sync now" button can trigger it on demand.
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

  // Only one sync (this button, or the GitHub Actions daily run) may ever
  // run at once — see lib/syncLock.ts's own doc comment for why: two
  // overlapping syncs previously raced on the same in-process Playwright
  // browser and crashed each other mid-run. A second click (or a click
  // while the scheduled run is in progress) is rejected outright rather
  // than queued or run concurrently.
  const lock = await acquireSyncLock("vercel-manual");
  if (!lock.acquired) {
    return NextResponse.json({ error: lockedMessage(lock.heldBy) }, { status: 409 });
  }

  const startedAt = Date.now();
  try {
    await runAllAdapters(ids);
  } finally {
    await releaseSyncLock(lock.token);
  }
  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sources: ids ?? "all",
  });
}
