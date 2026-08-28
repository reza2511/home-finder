import { NextResponse } from "next/server";
import { captureTrackerBackupNow } from "@/lib/trackerBackupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Invoked once daily by Vercel Cron (see the "crons" entry in vercel.json) —
// same CRON_SECRET pattern as app/api/cron/history-snapshot/route.ts (that
// route's own comment explains the header check in full). A duplicate/
// overlapping invocation just re-upserts today's backup row rather than
// corrupting anything (see lib/trackerBackupStore.ts's captureTrackerBackupNow).
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
    const backup = await captureTrackerBackupNow();
    return NextResponse.json({ ok: true, backup });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
