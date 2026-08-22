-- Two changes to refresh history:
--
-- 1. Public read access. Viewing history (list + recall a snapshot) is now
--    public, same as listings/sync_status — only *capturing* a new snapshot
--    stays login-only (enforced in app/api/history/capture/route.ts, a
--    Next.js route check, not RLS — there's no anon/authenticated write
--    policy on either table below, so even bypassing that route entirely,
--    the anon key still can't write here). Mirrors 0001_init.sql's own
--    "publicly readable, service_role-only writes" pattern for
--    listings/sync_status.
--
-- 2. Per-snapshot source breakdown, computed once at capture time and
--    stored alongside it (not recomputed on every list read) — the info
--    tooltip on each history entry needs "how many sources, which ones,
--    how many listings each" without fetching that snapshot's full (often
--    1000+ row) listings payload just to render a list item.

drop policy if exists "sync_runs are publicly readable" on sync_runs;
create policy "sync_runs are publicly readable"
  on sync_runs for select
  using (true);

drop policy if exists "sync_history_snapshots are publicly readable" on sync_history_snapshots;
create policy "sync_history_snapshots are publicly readable"
  on sync_history_snapshots for select
  using (true);

alter table sync_history_snapshots
  add column if not exists sources jsonb not null default '[]'::jsonb;
