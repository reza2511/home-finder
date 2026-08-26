import { randomUUID } from "node:crypto";
import { requireSupabaseAdmin } from "./db";
import { logSyncEvent } from "./dropGuard";

/**
 * A single, DB-backed lock (supabase/migrations/0011_sync_lock.sql) that
 * makes sure only one sync — the GitHub Actions daily run
 * (scripts/run-sync.ts) or the Vercel "Run sync now" button
 * (app/api/sync/route.ts) — is ever running at once, across processes and
 * machines (a plain in-memory flag can't do that; this table can, since
 * both callers write to the same Supabase project).
 *
 * 2026-08-24: two overlapping syncs raced on the same in-process shared
 * Playwright browser (lib/adapters/browser.ts) and crashed each other mid-
 * run — several sources failed at nearly the same instant with
 * "browser.newContext: Target page, context or browser has been closed",
 * and Redrow lost its listings entirely as fallout. Giving each source its
 * own browser (see that file) stops one source's crash from taking down
 * others *within* a run; this lock is what stops two runs from ever
 * overlapping in the first place — both matter, neither replaces the
 * other.
 *
 * A caller acquires the lock ONCE, for the entire sync session (every
 * source it's about to run, not per-source) — acquiring and releasing
 * around each individual source instead would leave real gaps between
 * sources where a second sync could still slip in and collide, which is
 * exactly the bug this exists to prevent.
 */

const LOCK_ROW_ID = 1;

// Absolute safety valve, not the normal path: if whatever holds the lock
// crashed (killed process, OOM, a cancelled GitHub Actions run) without
// ever reaching its own `finally` to release it, the lock would otherwise
// stay held forever and wedge every future sync. A run that's still
// genuinely in progress is always far newer than this, so it can never be
// preempted by mistake — this only ever fires against an abandoned lock.
// The daily-sync workflow's own `timeout-minutes` is 340 (~5h40m, sized
// for every one of ~18 sources hitting its own 900s adapter timeout back
// to back — see that file and ADAPTER_TIMEOUT_MS in lib/syncEngine.ts),
// so this needs real headroom above that worst case, not just above a
// normal run's actual few-minutes duration. This is the default, used by
// the GitHub Actions caller — acquireSyncLock's `staleMs` param lets a
// caller with a much smaller legitimate worst-case (the Vercel manual
// trigger — see app/api/sync/route.ts) opt into a much shorter one, so a
// killed request self-heals in minutes instead of hours.
const STALE_LOCK_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface SyncLockInfo {
  lockedAt: string;
  lockedBy: string;
}

export type AcquireSyncLockResult =
  | { acquired: true; token: string }
  | { acquired: false; heldBy: SyncLockInfo };

/**
 * Attempts to take the lock. `label` identifies who's asking (e.g.
 * "github-actions" or "vercel-manual") purely to make a rejection message
 * readable — it plays no role in whether the lock is granted.
 *
 * `staleMs` (default STALE_LOCK_MS, 6h) is how old a held lock has to be
 * before it's treated as abandoned rather than a run still genuinely in
 * progress — see STALE_LOCK_MS's own comment. Callers whose own worst-case
 * run time is much shorter than 6h (the Vercel manual trigger, now bounded
 * to a single source per request — see app/api/sync/route.ts) should pass
 * a smaller value so a request Vercel kills for exceeding its own function
 * timeout doesn't leave every other sync locked out for hours over it.
 *
 * Race-safe via compare-and-swap: reads the row's current `locked_at`,
 * then writes the new lock only `where locked_at` still equals exactly
 * what was just read (including matching a real `null` when free). If a
 * concurrent caller already took it in between, that `where` no longer
 * matches, the update touches zero rows, and this correctly reports the
 * lock as held rather than believing it won a race it didn't — the same
 * guarantee a single atomic `UPDATE ... WHERE` gives you in raw SQL,
 * expressed through PostgREST's read-then-conditional-write instead since
 * there's no server-side function to do it in one round trip here.
 */
export async function acquireSyncLock(
  label: string,
  staleMs: number = STALE_LOCK_MS
): Promise<AcquireSyncLockResult> {
  const admin = requireSupabaseAdmin();

  const { data: current, error: readErr } = await admin
    .from("sync_lock")
    .select("locked_at, locked_by")
    .eq("id", LOCK_ROW_ID)
    .single<{ locked_at: string | null; locked_by: string | null }>();
  if (readErr || !current) {
    throw new Error(`acquireSyncLock: failed to read lock state: ${readErr?.message ?? "no row"}`);
  }

  const isFree = current.locked_at === null;
  const isStale = !isFree && Date.now() - new Date(current.locked_at!).getTime() > staleMs;
  if (!isFree && !isStale) {
    return { acquired: false, heldBy: { lockedAt: current.locked_at!, lockedBy: current.locked_by ?? "unknown" } };
  }

  const token = randomUUID();
  let query = admin
    .from("sync_lock")
    .update({ locked_at: new Date().toISOString(), locked_by: label, lock_token: token })
    .eq("id", LOCK_ROW_ID);
  query = isFree ? query.is("locked_at", null) : query.eq("locked_at", current.locked_at!);

  const { data: written, error: writeErr } = await query.select("locked_at").maybeSingle();
  if (writeErr) {
    throw new Error(`acquireSyncLock: failed to take lock: ${writeErr.message}`);
  }
  if (!written) {
    // Lost the race between the read above and this write — re-read for an
    // accurate, current rejection message rather than reporting stale info.
    const { data: latest } = await admin
      .from("sync_lock")
      .select("locked_at, locked_by")
      .eq("id", LOCK_ROW_ID)
      .single<{ locked_at: string | null; locked_by: string | null }>();
    return {
      acquired: false,
      heldBy: {
        lockedAt: latest?.locked_at ?? current.locked_at!,
        lockedBy: latest?.locked_by ?? current.locked_by ?? "unknown",
      },
    };
  }

  // Safe self-healing: this caller just auto-cleared a stuck lock (held
  // past its own staleMs, so no run is genuinely still in progress) simply
  // by winning the compare-and-swap above — nothing destructive, and
  // exactly what the staleness fallback was already designed to do (see
  // STALE_LOCK_MS's own comment). Logged here purely so it's visible in
  // the Status Monitor's auto-actions list rather than a silent DB write —
  // best-effort, never lets a logging hiccup affect the lock this function
  // already successfully took.
  if (isStale) {
    const heldForMs = Date.now() - new Date(current.locked_at!).getTime();
    await logSyncEvent(
      "auto_lock_clear",
      null,
      `Auto-cleared a stale sync lock held by "${current.locked_by ?? "unknown"}" for ${Math.round(heldForMs / 1000)}s (past its ${Math.round(staleMs / 1000)}s staleness limit) — reclaimed by "${label}".`,
      { previousLockedBy: current.locked_by, previousLockedAt: current.locked_at, heldForMs, staleMs }
    );
  }

  return { acquired: true, token };
}

/**
 * Releases the lock — but only if `token` matches what's currently
 * recorded, i.e. only if this caller still actually holds it. Without that
 * check, a caller whose lock was reclaimed as abandoned (STALE_LOCK_MS
 * above) could finally reach its own release call late and clobber
 * whoever holds the lock now. Best-effort: a failure here is logged, never
 * thrown — the sync itself already finished (successfully or not) by the
 * time this runs, and a lock that fails to release gets reclaimed by the
 * staleness check above rather than wedging things forever.
 */
export async function releaseSyncLock(token: string): Promise<void> {
  const admin = requireSupabaseAdmin();
  const { error } = await admin
    .from("sync_lock")
    .update({ locked_at: null, locked_by: null, lock_token: null })
    .eq("id", LOCK_ROW_ID)
    .eq("lock_token", token);
  if (error) {
    console.warn(`[syncLock] releaseSyncLock: failed to release (non-fatal): ${error.message}`);
  }
}

/** Human-readable rejection message shared by both callers (the GitHub
 * Actions script and the API route) so "someone else is syncing" always
 * reads the same way regardless of which one said it. */
export function lockedMessage(heldBy: SyncLockInfo): string {
  return (
    `A sync is already in progress (started by "${heldBy.lockedBy}" at ${heldBy.lockedAt}) — ` +
    `only one sync may run at a time. Try again once it finishes.`
  );
}
