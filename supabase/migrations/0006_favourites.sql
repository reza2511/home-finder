-- Private favourites, for the app's single operator account.
--
-- The `favourites` table already existed (0001_init.sql) but was never
-- wired up — its `user_id` column FKs to `auth.users`, Supabase's own
-- built-in auth tables, which this app has never used (see lib/auth.ts: a
-- single fixed "reza" account behind a signed cookie session, not per-user
-- Supabase Auth accounts, so `auth.users` has no rows and `auth.uid()`
-- always returns null here). Repointed at a plain text identifier instead
-- — there's only ever one real user, so this is mostly for schema clarity/
-- future-proofing rather than real multi-tenancy.
--
-- Private, not public (unlike listings/sync_status/history): RLS is
-- enabled with NO policy on either table below, so anon/authenticated
-- Supabase roles get nothing at all — the only access path is the
-- service_role key, gated by this app's own isAuthenticated() check on
-- every favourites route (app/api/favourites/*). Same "admin-only, real
-- enforcement is the Next.js route, not RLS" pattern sync_runs/
-- sync_history_snapshots used before the refresh-history feature was made
-- deliberately public.

-- Must drop the policy before altering the column type — Postgres refuses
-- to change the type of a column a policy expression references.
drop policy if exists "users manage their own favourites" on favourites;

alter table favourites drop constraint if exists favourites_user_id_fkey;
alter table favourites alter column user_id type text using user_id::text;
alter table favourites alter column user_id set default 'reza';
update favourites set user_id = 'reza' where user_id is null;
alter table favourites alter column user_id set not null;

-- ---------- favourite_removals ----------
-- Records a favourited listing later going inactive during a sync (see
-- lib/listingsStore.ts's upsertListingsForSource, which calls
-- lib/favouritesStore.ts's recordRemovedFavourites right after marking
-- rows inactive) — title/url are stored as they were at removal time
-- (denormalized, not a live join) so the notification stays meaningful
-- even though the `listings` row itself is only soft-removed (active =
-- false), never deleted.

create table if not exists favourite_removals (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default 'reza',
  source_id   text not null,
  external_id text not null,
  title       text not null,
  url         text not null,
  removed_at  timestamptz not null default now()
);

create index if not exists idx_favourite_removals_user
  on favourite_removals (user_id, removed_at desc);

alter table favourite_removals enable row level security;
