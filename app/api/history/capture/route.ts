import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { captureSnapshotNow } from "@/lib/historyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Just DB reads/writes (no Playwright, no sync) — but the listings table
// can be large, so keep some headroom beyond the Vercel default.
export const maxDuration = 60;

// Same real, server-side session check as POST /api/sync — a public
// visitor gets 401 regardless of what the UI does or doesn't show. Unlike
// GET /api/history and GET /api/history/:id (public — viewing history is
// for everyone), *capturing* a new snapshot stays login-only.
export async function POST() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in to capture history." }, { status: 401 });
  }

  try {
    const snapshot = await captureSnapshotNow();
    return NextResponse.json({ ok: true, snapshot });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
