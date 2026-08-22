import { NextResponse } from "next/server";
import { captureSnapshotNow } from "@/lib/historyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Invoked once daily at 06:00 by Vercel Cron (see the "crons" entry in
// vercel.json) — captures whatever's currently in `listings` right now, no
// "is anything due" check involved (see lib/historyStore.ts's file header
// for why that logic was removed). A duplicate/overlapping invocation just
// adds one extra history entry rather than corrupting anything — pruning
// to the 10 most recent snapshots (captureSnapshotNow's own last step)
// cleans that up on its own.
//
// Protected by CRON_SECRET, Vercel's own documented pattern
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs):
// when that env var is set, Vercel automatically sends it as this request's
// Authorization header, so only Vercel's own scheduler (or someone who
// knows the secret) can trigger a capture. Deliberately NOT required when
// CRON_SECRET isn't set (e.g. local dev, or before it's been added to
// Vercel's project env vars) — degrades to "anyone can nudge today's
// capture to happen early", not a way to read or corrupt history data.
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
    const snapshot = await captureSnapshotNow();
    return NextResponse.json({ ok: true, snapshot });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
