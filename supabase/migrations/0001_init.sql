-- Home Finder — initial Supabase schema.
-- Mirrors the existing local SQLite schema (lib/db.ts) for listings/sync_status,
-- plus a new favourites table. Safe to re-run (IF NOT EXISTS throughout).

create extension if not exists pgcrypto;

-- ---------- listings ----------

create table if not exists listings (
  source_id     text not null,
  external_id   text not null,
  title         text not null,
  price         text not null,
  price_value   integer not null default 0,
  url           text not null,
  images        jsonb not null default '[]'::jsonb,
  main_image    text,
  bedrooms      integer,
  bedroom_type  text,
  tenure        text,
  is_new_build  boolean not null default false,
  postcode      text,
  area          text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  active        boolean not null default true,
  primary key (source_id, external_id)
);

create index if not exists idx_listings_active on listings (active);

alter table listings enable row level security;

drop policy if exists "listings are publicly readable" on listings;
create policy "listings are publicly readable"
  on listings for select
  using (true);
-- No insert/update/delete policy for anon/authenticated: writes are done by
-- the sync job using the service_role key, which bypasses RLS entirely.

-- ---------- sync_status ----------

create table if not exists sync_status (
  source_id         text primary key,
  source_name       text not null,
  last_run_at       timestamptz,
  last_success_at   timestamptz,
  status            text not null,
  http_status       integer,
  listings_found    integer not null default 0,
  added             integer not null default 0,
  updated           integer not null default 0,
  removed           integer not null default 0,
  duration_ms       integer,
  error_message     text,
  extraction_method text
);

alter table sync_status enable row level security;

drop policy if exists "sync_status is publicly readable" on sync_status;
create policy "sync_status is publicly readable"
  on sync_status for select
  using (true);

-- ---------- favourites ----------
-- user_id is nullable and FKs to auth.users for when Supabase Auth is wired
-- up; the app doesn't have auth yet, so this column simply sits unused until
-- then rather than forcing that decision now.

create table if not exists favourites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete cascade,
  source_id   text not null,
  external_id text not null,
  created_at  timestamptz not null default now(),
  foreign key (source_id, external_id) references listings (source_id, external_id) on delete cascade,
  unique (user_id, source_id, external_id)
);

create index if not exists idx_favourites_listing on favourites (source_id, external_id);
create index if not exists idx_favourites_user on favourites (user_id);

alter table favourites enable row level security;

drop policy if exists "users manage their own favourites" on favourites;
create policy "users manage their own favourites"
  on favourites for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
