import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createTrackerRow, listTrackerRows } from "@/lib/trackerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same reasoning as app/api/compare/route.ts: adding one row can need a
// full Playwright render (up to ~60s) plus an Anthropic call (up to ~45s).
export const maxDuration = 300;

// Real server-side auth gate, not a front-end nicety — same as POST
// /api/compare and every other /api/favourites route. See lib/auth.ts.
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
    const rows = await listTrackerRows();
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface CreateBody {
  url?: unknown;
}

export async function POST(request: Request) {
  const denied = requireAuth();
  if (denied) return denied;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "A property URL is required." }, { status: 400 });
  }

  try {
    const row = await createTrackerRow(url);
    return NextResponse.json({ row });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
