-- Daily statistics snapshots for the public Statistics page — one row per
-- calendar date (UTC), with the total active-listing count and a per-source
-- breakdown at the moment of capture. See lib/statsStore.ts:
-- captureDailyStatsSnapshot() is called at the end of every runAllAdapters()
-- run (lib/syncEngine.ts) — in practice, once a day via the GitHub Actions
-- daily sync — and upserts on `date`, so a re-sync on the same day just
-- refreshes that day's row rather than creating a duplicate.
--
-- Deliberately a SEPARATE table from sync_history_snapshots (0004/0005),
-- not a replacement for it: that table stores each snapshot's full listings
-- payload and is intentionally pruned to the 10 most recent (see
-- lib/historyStore.ts's MAX_KEPT_SNAPSHOTS) — exactly wrong for a
-- long-running trend history. This table stores only a count + a small
-- per-source summary (no listings payload), so it's cheap to keep forever
-- — one small row per day, never pruned.
--
-- Same "publicly readable, service_role-only writes" pattern as
-- listings/sync_status (0001_init.sql): no anon/authenticated insert/
-- update/delete policy at all, so only the service_role key (used by
-- lib/statsStore.ts) can ever write here.

create table if not exists stats_daily_snapshots (
  date         date primary key,
  total_count  integer not null default 0,
  -- [{ sourceId, sourceName, listingCount }, ...] — same shape as
  -- sync_history_snapshots.sources (0005), computed the same way
  -- (lib/sourceBreakdown.ts), so the two stay directly comparable.
  sources      jsonb not null default '[]'::jsonb,
  captured_at  timestamptz not null default now()
);

alter table stats_daily_snapshots enable row level security;

drop policy if exists "stats_daily_snapshots are publicly readable" on stats_daily_snapshots;
create policy "stats_daily_snapshots are publicly readable"
  on stats_daily_snapshots for select
  using (true);
