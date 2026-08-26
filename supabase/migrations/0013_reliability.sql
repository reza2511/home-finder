-- Reliability features (2026-08-25), added after today's incident (a bad
-- sync wiped ~1,000 listings) and the fixes for its root causes
-- (lib/listingsStore.ts's zero-results guard, lib/syncEngine.ts's
-- prune/lock split — see that migration history for the postmortem).
-- These three tables/columns add a second, structural layer on top of
-- those fixes: a drop guard that can refuse to apply a still-abnormal
-- removal even if some future bug reopens this class of problem, a
-- persistent health flag the UI reads, and an audit trail of every
-- automatic action the sync machinery ever takes.

-- ---------- sync_events_log ----------
-- Append-only audit trail for anything the sync machinery does
-- automatically, without a human clicking a button: a drop-guard
-- rejection, a one-shot retry of a transiently-failed source, or an
-- auto-clear of a stale sync lock. See lib/dropGuard.ts (the only writer)
-- and GET /api/sync-events (the only reader) — surfaced in the Status
-- Monitor so every auto-action is visible, not just console output. Same
-- "publicly readable, service_role-only writes" shape as sync_runs_log/
-- sync_run_source_log (0012_sync_run_log.sql).
create table if not exists sync_events_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  event_type  text not null check (event_type in ('drop_guard_rejected', 'auto_retry', 'auto_lock_clear')),
  source_id   text,
  message     text not null,
  details     jsonb
);

create index if not exists idx_sync_events_log_created_at on sync_events_log (created_at desc);

alter table sync_events_log enable row level security;

drop policy if exists "sync_events_log is publicly readable" on sync_events_log;
create policy "sync_events_log is publicly readable"
  on sync_events_log for select
  using (true);
-- No anon/authenticated write policy — only the service_role key
-- (lib/dropGuard.ts) ever inserts.

-- ---------- sync_health ----------
-- Singleton row (id = 1), same shape/reasoning as sync_lock
-- (0011_sync_lock.sql): a persistent FLAG, not a log entry, so it survives
-- across requests and deploys. drop_guard_active is set the moment the
-- drop guard rejects a removal, and stays true — a "needs my attention"
-- state — until a human explicitly clears it (POST /api/health/acknowledge,
-- lib/dropGuard.ts's clearDropGuardFlag). It is deliberately NEVER cleared
-- automatically by a later successful sync: a clean sync of some OTHER
-- source says nothing about whether the rejected drop was a real,
-- intentional change that still needs a human decision.
create table if not exists sync_health (
  id                       int primary key,
  drop_guard_active        boolean not null default false,
  drop_guard_message       text,
  drop_guard_triggered_at  timestamptz,
  updated_at               timestamptz not null default now()
);

alter table sync_health enable row level security;

drop policy if exists "sync_health is publicly readable" on sync_health;
create policy "sync_health is publicly readable"
  on sync_health for select
  using (true);

insert into sync_health (id, drop_guard_active, drop_guard_message, drop_guard_triggered_at, updated_at)
values (1, false, null, null, now())
on conflict (id) do nothing;

-- ---------- sync_status.drop_guard_triggered ----------
-- Per-source flag on the LATEST run only (mirrors every other column on
-- this table — see 0001_init.sql) — true when that source's most recent
-- sync had a removal the drop guard rejected, so the Status Monitor's own
-- per-source row can show it directly, independent of the site-wide
-- sync_health flag above.
alter table sync_status add column if not exists drop_guard_triggered boolean not null default false;
