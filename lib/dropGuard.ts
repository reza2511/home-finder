import { requireSupabaseAdmin, supabase } from "./db";

/**
 * How much the SITE-WIDE active-listing total is allowed to drop from one
 * source's removal before it's treated as suspicious rather than a real,
 * organic change (agents letting a development sell out, a source
 * retiring a stale page, etc.).
 *
 * THIS IS THE ONE NUMBER TO EDIT to retune the guard — nothing else in
 * this file needs to change. Keep it somewhere in the 5–10% range for
 * normal day-to-day churn; raise it if real syncs start getting rejected
 * for genuinely large (but real) drops, lower it if an abnormal drop still
 * slips through. For scale: the 2026-08-25 incident this guards against
 * was a single sync dropping the site-wide total from 1,469 to ~530 — a
 * ~64% drop — nowhere close to even a generous threshold here.
 */
export const DROP_GUARD_THRESHOLD_PERCENT = 8;

export interface DropGuardResult {
  allowed: boolean;
  previousActiveTotal: number;
  candidateRemovedCount: number;
  dropPercent: number;
}

/**
 * Evaluated once per source's removal diff (lib/listingsStore.ts's
 * upsertListingsForSource), immediately before those removals would be
 * committed. Deliberately a SITE-WIDE check, not a per-source one: a
 * single source going to zero is exactly the failure this exists to
 * catch, and "this source dropped 100%" on its own says nothing about how
 * big that source actually is relative to the whole database (1newhomes
 * losing all 583 of its listings is a ~40% site-wide drop; Ballymore
 * losing all 4 is under 1%, and would be quietly waved through by a
 * per-source-100%-only rule).
 *
 * `previousActiveTotal` is read fresh — a real `count(*) where active`
 * query, right before the decision — never cached, so it always reflects
 * whatever the database genuinely holds at this moment, including any
 * removals another source already committed earlier in the same run.
 */
export async function evaluateDropGuard(candidateRemovedCount: number): Promise<DropGuardResult> {
  const admin = requireSupabaseAdmin();
  const { count, error } = await admin
    .from("listings")
    .select("*", { count: "exact", head: true })
    .eq("active", true);
  if (error) {
    throw new Error(`evaluateDropGuard: failed to read current active total: ${error.message}`);
  }
  const previousActiveTotal = count ?? 0;
  if (previousActiveTotal === 0 || candidateRemovedCount === 0) {
    return { allowed: true, previousActiveTotal, candidateRemovedCount, dropPercent: 0 };
  }
  const dropPercent = (candidateRemovedCount / previousActiveTotal) * 100;
  return {
    allowed: dropPercent <= DROP_GUARD_THRESHOLD_PERCENT,
    previousActiveTotal,
    candidateRemovedCount,
    dropPercent,
  };
}

export type SyncEventType = "drop_guard_rejected" | "auto_retry" | "auto_lock_clear";

/**
 * Appends one row to the audit trail (supabase/migrations/0013_reliability.sql's
 * sync_events_log) — every automatic action the sync machinery ever takes
 * without a human clicking a button. Best-effort like the rest of this
 * app's own logging (lib/syncRunLog.ts, recordRemovedFavourites in
 * lib/listingsStore.ts): a failure here must never mask or block the real
 * action it's describing.
 */
export async function logSyncEvent(
  eventType: SyncEventType,
  sourceId: string | null,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { error } = await admin.from("sync_events_log").insert({
    event_type: eventType,
    source_id: sourceId,
    message,
    details: details ?? null,
  });
  if (error) {
    console.warn(`[dropGuard] logSyncEvent(${eventType}): insert failed (non-fatal): ${error.message}`);
  }
}

/**
 * Sets the site-wide "needs my attention" flag (sync_health, singleton row
 * id=1) the moment a drop-guard rejection happens. Best-effort — a failed
 * write here must never stop the real rejection (skipping the removal)
 * from taking effect; sync_events_log above is the durable record either
 * way, this is just the always-visible banner on top of it.
 */
export async function setDropGuardFlag(message: string): Promise<void> {
  const admin = requireSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await admin
    .from("sync_health")
    .update({
      drop_guard_active: true,
      drop_guard_message: message,
      drop_guard_triggered_at: now,
      updated_at: now,
    })
    .eq("id", 1);
  if (error) {
    console.warn(`[dropGuard] setDropGuardFlag: update failed (non-fatal): ${error.message}`);
  }
}

/**
 * The ONLY way the drop-guard flag ever clears — a deliberate human
 * decision (POST /api/health/acknowledge), never automatic. See this
 * file's own module comment and supabase/migrations/0013_reliability.sql's
 * sync_health comment for why: a later successful sync of some OTHER
 * source says nothing about whether the rejected drop was real, so
 * nothing in the sync path itself is allowed to silently clear this.
 * Unlike setDropGuardFlag, this one throws on failure — a "clear" that
 * silently didn't take would be actively misleading to whoever clicked it.
 */
export async function clearDropGuardFlag(): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { error } = await admin
    .from("sync_health")
    .update({
      drop_guard_active: false,
      drop_guard_message: null,
      drop_guard_triggered_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) {
    throw new Error(`clearDropGuardFlag: update failed: ${error.message}`);
  }
}

export interface SyncHealthRow {
  dropGuardActive: boolean;
  dropGuardMessage: string | null;
  dropGuardTriggeredAt: string | null;
}

/** Public/anon read of the current flag state — used by GET /api/health.
 * Falls back to "not active" (rather than throwing) on a read failure, the
 * same fail-open convention Header.tsx's status polling already uses for
 * GET /api/status — a broken health check must never itself look like an
 * incident. */
export async function getSyncHealthRow(): Promise<SyncHealthRow> {
  const { data, error } = await supabase
    .from("sync_health")
    .select("drop_guard_active, drop_guard_message, drop_guard_triggered_at")
    .eq("id", 1)
    .maybeSingle<{ drop_guard_active: boolean; drop_guard_message: string | null; drop_guard_triggered_at: string | null }>();
  if (error || !data) {
    console.warn(`[dropGuard] getSyncHealthRow: read failed (non-fatal): ${error?.message ?? "no row"}`);
    return { dropGuardActive: false, dropGuardMessage: null, dropGuardTriggeredAt: null };
  }
  return {
    dropGuardActive: data.drop_guard_active,
    dropGuardMessage: data.drop_guard_message,
    dropGuardTriggeredAt: data.drop_guard_triggered_at,
  };
}
