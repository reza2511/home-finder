import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { clearDropGuardFlag } from "@/lib/dropGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ONLY way the drop-guard "needs my attention" flag ever clears — a
 * deliberate, authenticated human action, never automatic (see
 * lib/dropGuard.ts's clearDropGuardFlag and
 * supabase/migrations/0013_reliability.sql's sync_health comment for why).
 * This does not re-run anything, re-sync anything, or touch `listings` —
 * it only clears the flag itself, once the person reviewing it has
 * decided the rejected drop was checked out (real listings really did go
 * away — a follow-up real sync will pick that up normally — or it was a
 * one-off blip already resolved).
 *
 * Deliberately NOT written to sync_events_log — that table is scoped to
 * actions the sync machinery takes automatically (see its own comment in
 * supabase/migrations/0013_reliability.sql); this is the opposite of
 * automatic. sync_health's own `updated_at` already records when the flag
 * was last cleared, which is audit trail enough for a manual action.
 */
export async function POST() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in to acknowledge this." }, { status: 401 });
  }
  await clearDropGuardFlag();
  return NextResponse.json({ ok: true });
}
