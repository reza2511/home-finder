import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { getSyncHealthRow } from "@/lib/dropGuard";
import { adapters } from "@/lib/adapters";
import type { HealthResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A sync_runs_log row that's been sitting unfinished for longer than any
// real single-source request could legitimately still be running gets
// treated as a failed/killed run, not "still in progress" — see
// app/api/sync/route.ts's own maxDuration (300s) and MANUAL_STALE_LOCK_MS
// (20 min); this is deliberately a bit more than either, so a run that's
// merely slow doesn't flash red before it's actually had a fair chance to
// finish. This is exactly the shape of the 2026-08-25 incident this whole
// feature set traces back to: a run whose finished_at stayed null forever
// after Vercel killed the request mid-way.
const STUCK_RUN_THRESHOLD_MS = 25 * 60 * 1000;

interface SyncStatusHealthRow {
  status: string;
}

interface RunLogRow {
  started_at: string;
  finished_at: string | null;
}

/**
 * Computes the site's overall health — read by the HealthIndicator
 * component (near Status Monitor / Clear cache in Header.tsx) and safe to
 * poll frequently: every check here is a plain read against
 * publicly-readable tables (sync_status, sync_health, sync_runs_log,
 * listings — see their own RLS policies), no auth, no side effects.
 *
 * RED when any of:
 *  - the drop guard is currently active (lib/dropGuard.ts's sync_health
 *    flag) — set the moment a removal gets rejected, cleared only by a
 *    human via POST /api/health/acknowledge. `needsAttention: true` for
 *    this one specifically — it can't resolve itself.
 *  - the most recent sync run has sat unfinished for longer than
 *    STUCK_RUN_THRESHOLD_MS — the same "request got killed mid-run"
 *    signature as the 2026-08-25 incident.
 *  - any currently-registered source has zero active listings right now
 *    ("a source group is unexpectedly empty") — the exact symptom that
 *    incident actually looked like from the outside.
 *  - any source's LATEST recorded run ended in `error`.
 *
 * GREEN otherwise: last sync(es) recorded fine, no drop-guard trigger, no
 * empty source group.
 */
export async function GET() {
  // Per-source active counts via individual head:true/count:exact queries
  // (one per registered adapter, run in parallel) rather than one
  // select("source_id") over every active listing: PostgREST caps a single
  // response at 1000 rows (see lib/db.ts's distinctSourceIds for the same
  // constraint elsewhere in this app), and the site is already past 1,400
  // active listings — a plain select would silently undercount both the
  // total and which sources look empty. count:"exact" with head:true
  // returns just the count, never subject to that row cap.
  const [statusResult, healthFlag, runsResult, totalActiveResult, perSourceCounts] = await Promise.all([
    supabase.from("sync_status").select("source_id, status").returns<
      (SyncStatusHealthRow & { source_id: string })[]
    >(),
    getSyncHealthRow(),
    supabase
      .from("sync_runs_log")
      .select("started_at, finished_at")
      .order("started_at", { ascending: false })
      .limit(1)
      .returns<RunLogRow[]>(),
    supabase.from("listings").select("*", { count: "exact", head: true }).eq("active", true),
    Promise.all(
      adapters.map(async (a) => {
        const { count, error } = await supabase
          .from("listings")
          .select("*", { count: "exact", head: true })
          .eq("source_id", a.id)
          .eq("active", true);
        return { sourceId: a.id, sourceName: a.name, activeCount: error ? null : count ?? 0 };
      })
    ),
  ]);

  if (statusResult.error) {
    return NextResponse.json({ error: `Failed to read sync_status: ${statusResult.error.message}` }, { status: 500 });
  }
  if (totalActiveResult.error) {
    return NextResponse.json({ error: `Failed to read listings: ${totalActiveResult.error.message}` }, { status: 500 });
  }

  const reasons: string[] = [];
  let status: "green" | "red" = "green";
  let needsAttention = false;

  // 1. Drop guard.
  if (healthFlag.dropGuardActive) {
    status = "red";
    needsAttention = true;
    reasons.push(healthFlag.dropGuardMessage ?? "Drop guard triggered — sync rejected, review needed.");
  }

  // 2. A run that never finished, well past any legitimate duration.
  const latestRun = runsResult.data?.[0];
  if (latestRun && !latestRun.finished_at) {
    const ageMs = Date.now() - new Date(latestRun.started_at).getTime();
    if (ageMs > STUCK_RUN_THRESHOLD_MS) {
      status = "red";
      reasons.push(
        `Last sync run started ${Math.round(ageMs / 60000)} min ago and never finished — likely killed mid-run.`
      );
    }
  }

  // 3. Any currently-registered source with zero active listings. A failed
  // per-source count query (activeCount: null) is treated as "not empty"
  // — a read hiccup must never masquerade as the exact incident this
  // check exists to catch.
  const emptySources = perSourceCounts
    .filter((s) => s.activeCount === 0)
    .map((s) => ({ sourceId: s.sourceId, sourceName: s.sourceName }));
  if (emptySources.length > 0) {
    status = "red";
    reasons.push(
      `${emptySources.length} source(s) have zero active listings: ${emptySources.map((s) => s.sourceId).join(", ")}`
    );
  }

  // 4. Any source's latest run ended in a real error.
  const erroredSources = (statusResult.data ?? []).filter((r) => r.status === "error");
  if (erroredSources.length > 0) {
    status = "red";
    reasons.push(
      `${erroredSources.length} source(s) failed their last sync: ${erroredSources.map((r) => r.source_id).join(", ")}`
    );
  }

  const totalActive = totalActiveResult.count ?? 0;
  if (status === "green") {
    reasons.push(`Last sync OK, ${totalActive.toLocaleString("en-GB")} listings.`);
  }

  const body: HealthResponse = {
    status,
    reasons,
    needsAttention,
    totalActive,
    dropGuardActive: healthFlag.dropGuardActive,
    dropGuardMessage: healthFlag.dropGuardMessage,
    dropGuardTriggeredAt: healthFlag.dropGuardTriggeredAt,
    emptySources,
  };
  return NextResponse.json(body);
}
