import { NextResponse } from "next/server";
import { captureDueSnapshots } from "@/lib/historyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Invoked once daily by Vercel Cron (see the "crons" entry in vercel.json —
// the Hobby plan rejects any more-frequent schedule at deploy time, see
// lib/historyStore.ts's file header) — this is what actually captures a
// snapshot ~2h after a sync started, since a live setTimeout can't survive
// on serverless. Idempotent: a run only ever gets captured once
// (captureDueSnapshots only selects sync_runs still missing a snapshot), so
// an extra/overlapping invocation is a safe no-op, not a duplicate snapshot.
//
// Protected by CRON_SECRET, Vercel's own documented pattern
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs):
// when that env var is set, Vercel automatically sends it as this request's
// Authorization header, so only Vercel's own scheduler (or someone who
// knows the secret) can trigger a capture. Deliberately NOT required when
// CRON_SECRET isn't set (e.g. local dev, or before it's been added to
// Vercel's project env vars) — the work itself is idempotent and safe to
// run unauthenticated, so an unset secret degrades to "anyone can nudge the
// job to check for due snapshots early", not a way to read or corrupt
// history data.
function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await captureDueSnapshots();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
