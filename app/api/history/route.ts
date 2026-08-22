import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { listRecentSnapshots } from "@/lib/historyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same real, server-side session check as POST /api/sync — a public
// visitor gets 401 regardless of what the front-end shows or hides. See
// lib/auth.ts.
export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in to view refresh history." }, { status: 401 });
  }

  try {
    const snapshots = await listRecentSnapshots();
    return NextResponse.json({ snapshots });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
