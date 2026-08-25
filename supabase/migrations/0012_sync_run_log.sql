-- Per-run sync history: unlike sync_status (0001_init.sql), which upserts
-- one row per source_id and only ever shows the LATEST run's numbers, these
-- two tables keep every past run's per-source added/updated/removed/found
-- counts plus the total active-listing count at the moment the run
-- finished — so a real day-over-day count change (1200 -> 1360 -> 1450) can
-- be told apart from a bug making one source wrongly collapse to near-zero,
-- by actually comparing runs against each other instead of only ever seeing
-- the most recent snapshot. See lib/syncRunLog.ts (the only code that
-- writes these) and GET /api/sync-history (the only reader).
--
-- One row per whole sync — scripts/run-sync.ts (github-actions) generates
-- one run id per script execution even though it internally calls
-- runAllAdapters() once per source; app/api/sync/route.ts (vercel-manual)
-- generates one per POST /api/sync. `total_active_count` is filled in once,
-- by finishSyncRunLog(), only after every source in the run has finished —
-- null while a run is still in progress or if it crashed before reaching
-- that point.
create table if not exists sync_runs_log (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  triggered_by        text not null,
  total_active_count  integer
);

create index if not exists idx_sync_runs_log_started_at
  on sync_runs_log (started_at desc);

alter table sync_runs_log enable row level security;

drop policy if exists "sync_runs_log is publicly readable" on sync_runs_log;
create policy "sync_runs_log is publicly readable"
  on sync_runs_log for select
  using (true);

-- One row per source per run — recorded right alongside each run's own
-- sync_status upsert (lib/syncEngine.ts's runOne), so the two always agree
-- on a given source's most recent numbers; this table is just the only one
-- that keeps every prior run's numbers too, not only the latest.
create table if not exists sync_run_source_log (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references sync_runs_log (id) on delete cascade,
  source_id       text not null,
  source_name     text not null,
  status          text not null,
  listings_found  integer not null default 0,
  added           integer not null default 0,
  updated         integer not null default 0,
  removed         integer not null default 0,
  deduped_count   integer not null default 0,
  duration_ms     integer,
  ran_at          timestamptz not null default now()
);

create index if not exists idx_sync_run_source_log_run_id
  on sync_run_source_log (run_id);

alter table sync_run_source_log enable row level security;

drop policy if exists "sync_run_source_log is publicly readable" on sync_run_source_log;
create policy "sync_run_source_log is publicly readable"
  on sync_run_source_log for select
  using (true);

-- Same "publicly readable, service_role-only writes" shape as
-- sync_status/listings (0001_init.sql): neither table above has an anon/
-- authenticated insert/update/delete policy, so only the service_role key
-- (lib/syncRunLog.ts, called from lib/syncEngine.ts) can ever write here.
