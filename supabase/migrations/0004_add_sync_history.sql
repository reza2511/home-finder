-- Refresh history: tracks each full sync's start time (sync_runs) and the
-- full listings snapshot captured ~2h after it started (sync_history_
-- snapshots) — see lib/historyStore.ts and app/api/cron/history-snapshot/
-- route.ts. Additive, safe to re-run.
--
-- Both tables are RLS-enabled with NO select/insert/update/delete policy for
-- anon or authenticated — unlike listings/sync_status (publicly readable),
-- this data is only ever touched via the service_role key from server-side
-- routes that have already checked lib/auth.ts's isAuthenticated() (or, for
-- the cron route, the CRON_SECRET header) themselves. Default-deny is the
-- actual enforcement of "the public cannot view or recall history" at the
-- database layer, independent of the API route logic.

create table if not exists sync_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  -- Set by the cron job once it has captured this run's snapshot. NULL means
  -- "still pending" — the job's own query filters on this being null.
  snapshotted_at timestamptz
);

create index if not exists idx_sync_runs_pending
  on sync_runs (started_at)
  where snapshotted_at is null;

alter table sync_runs enable row level security;

create table if not exists sync_history_snapshots (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references sync_runs (id) on delete cascade,
  captured_at   timestamptz not null default now(),
  listing_count integer not null default 0,
  -- Full snapshot of every active listing at capture time, in the same
  -- shape GET /api/listings returns (see lib/listingsQuery.ts) — enough to
  -- render the whole grid exactly as it was, not just a count.
  listings      jsonb not null
);

create index if not exists idx_sync_history_snapshots_captured_at
  on sync_history_snapshots (captured_at desc);

alter table sync_history_snapshots enable row level security;
