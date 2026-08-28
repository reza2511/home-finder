import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { listTrackerBackups, restoreTrackerBackup } from "@/lib/trackerBackupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireAuth(): NextResponse | null {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in." }, { status: 401 });
  }
  return null;
}

export async function GET() {
  const denied = requireAuth();
  if (denied) return denied;

  try {
    const backups = await listTrackerBackups();
    return NextResponse.json({ backups });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface RestoreBody {
  date?: unknown;
}

// Restores the whole tracker from one day's backup — a deliberately
// explicit, separate action (not folded into GET) since it overwrites every
// current row. See lib/trackerBackupStore.ts's restoreTrackerBackup for why
// it's a full replace rather than a merge.
export async function POST(request: Request) {
  const denied = requireAuth();
  if (denied) return denied;

  let body: RestoreBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const date = typeof body.date === "string" ? body.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "A valid date (YYYY-MM-DD) is required." }, { status: 400 });
  }

  try {
    const rows = await restoreTrackerBackup(date);
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
