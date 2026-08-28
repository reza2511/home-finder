-- Property Tracker: a private, login-only working list of properties the
-- operator is actively considering — separate from `favourites` (which only
-- ever holds a *currently active listing from a synced source*). A tracker
-- row can point at ANY property URL, including ones this app never synced,
-- and its fields are a mix of AI-extracted ("same as the compare page" —
-- see lib/trackerExtract.ts, which mirrors lib/compareExtract.ts's
-- fetch/render/ground approach) and purely manual (view date, comment, the
-- three tick boxes) — so unlike `listings`, this table is genuinely
-- user-writable, not sync-only.
--
-- Same "private, service_role-only" shape as favourites (0006_favourites.sql):
-- RLS enabled with NO policy for anon/authenticated on either table below,
-- so the only access path is the service_role key from routes that have
-- already called lib/auth.ts's isAuthenticated() themselves
-- (app/api/tracker/*) — real, server-side enforcement, not just the page
-- redirecting a logged-out visitor to /login.
--
-- `user_id` is a fixed text identifier ('reza'), not a Supabase Auth FK —
-- same reasoning as favourites: this app has one real account behind a
-- signed cookie session (lib/auth.ts), not per-user Supabase Auth rows.

create table if not exists property_tracker (
  id                uuid primary key default gen_random_uuid(),
  user_id           text not null default 'reza',
  url               text not null default '',
  price             text not null default '',
  bedrooms          text not null default '',
  floor             text not null default '',
  developer         text not null default '',
  address           text not null default '',
  -- Picked by the operator, never scraped — a plain date, no time-of-day.
  view_date         date,
  area              text not null default '',
  postcode          text not null default '',
  comment           text not null default '',
  rejected          boolean not null default false,
  viewed            boolean not null default false,
  contacted_agent   boolean not null default false,
  -- Set when the URL was added but couldn't be read (blocked/error) — the
  -- row is still created with blank AI fields rather than dropped, and the
  -- UI shows this as a "couldn't read this page" note. Null once every
  -- field has been filled in manually, if the operator chooses to clear it.
  extraction_note   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Rejected-last ordering (see components/PropertyTrackerTable.tsx) reads
-- rejected ascending (false before true) then created_at ascending, so a
-- ticked "Rejected" row moves to the bottom and unticking restores its
-- original position — this index serves exactly that query shape.
create index if not exists idx_property_tracker_user_order
  on property_tracker (user_id, rejected, created_at);

alter table property_tracker enable row level security;

-- ---------- property_tracker_backups ----------
-- One row per calendar date (UTC), holding a full JSON snapshot of every
-- property_tracker row for that user at capture time — captured once daily
-- by GET /api/cron/tracker-backup (see vercel.json's "crons" entry) via
-- lib/trackerBackupStore.ts. Upserts on (user_id, date), same pattern as
-- stats_daily_snapshots (0009): a re-capture on the same day just refreshes
-- that day's row rather than creating a duplicate, but every EARLIER day's
-- snapshot is left untouched — so "something went wrong today" still has
-- yesterday's (and every prior day's) good snapshot to recover from.
-- Deliberately never pruned: one small JSON blob per day, for a single
-- user's tracker, is cheap to keep forever.
create table if not exists property_tracker_backups (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null default 'reza',
  date         date not null,
  rows         jsonb not null,
  captured_at  timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists idx_property_tracker_backups_user_date
  on property_tracker_backups (user_id, date desc);

alter table property_tracker_backups enable row level security;
