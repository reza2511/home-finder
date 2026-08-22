import { NextResponse } from "next/server";
import { AUTH_USERNAME, isAuthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only, safe to be public — it only ever reveals whether *this*
// browser's own cookie is currently a valid session, never anyone else's
// state or anything secret. The front-end uses it to decide whether to show
// "Run sync now" vs a login link; the real protection lives server-side on
// the routes those actions actually hit (see lib/auth.ts).
export async function GET() {
  const authenticated = isAuthenticated();
  return NextResponse.json({ authenticated, username: authenticated ? AUTH_USERNAME : null });
}
