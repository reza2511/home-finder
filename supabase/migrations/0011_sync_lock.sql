-- A single-row lock used to make sure only one sync (the GitHub Actions
-- daily run, or the Vercel "Run sync now" button) is ever running at once.
-- 2026-08-24: two overlapping syncs (a GitHub Actions run and a manual
-- "Run sync now" click close behind it) raced on the same in-process
-- shared Playwright browser and crashed each other mid-run
-- ("browser.newContext: Target page, context or browser has been closed"
-- across several sources at nearly the same instant) — one source
-- (Redrow) lost its listings entirely as fallout. See lib/syncLock.ts,
-- which is the only code that ever reads/writes this table:
-- acquireSyncLock() takes it (compare-and-swap on `locked_at`, so two
-- concurrent callers can't both believe they won), releaseSyncLock()
-- frees it, checked against `lock_token` so a caller whose lock was
-- reclaimed as abandoned (see STALE_LOCK_MS there) can never release
-- whoever holds it now.
--
-- Always exactly one row (id = 1) — a lock, not a log; `locked_at is null`
-- means free. Same "publicly readable, service_role-only writes" shape as
-- every other table here (0001_init.sql) isn't right for this one: a lock
-- record only matters to the sync job itself, and the Status Monitor reads
-- sync_status, not this table, so there's no public-read case — no anon
-- policy is created at all, RLS with zero policies denies every anon/
-- authenticated request outright, leaving only the service_role key
-- (bypasses RLS) able to read or write it.

create table if not exists sync_lock (
  id         int primary key,
  locked_at  timestamptz,
  locked_by  text,
  lock_token text
);

alter table sync_lock enable row level security;

insert into sync_lock (id, locked_at, locked_by, lock_token)
values (1, null, null, null)
on conflict (id) do nothing;
