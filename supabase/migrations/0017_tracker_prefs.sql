-- Property Tracker display preferences — a single row per user, separate
-- from property_tracker itself since this isn't data about any one
-- property, it's a page-wide UI setting ("Don't show these again" for the
-- read-error indicator icons — see lib/trackerPrefsStore.ts and
-- components/PropertyTrackerTable.tsx). Same "service_role only, no
-- anon/authenticated RLS policy at all" shape as property_tracker itself
-- (0014_property_tracker.sql) — only reachable via a route that's already
-- checked isAuthenticated() (app/api/tracker/prefs/route.ts).

create table if not exists property_tracker_prefs (
  user_id                text primary key default 'reza',
  hide_extraction_notes  boolean not null default false,
  updated_at             timestamptz not null default now()
);

alter table property_tracker_prefs enable row level security;

insert into property_tracker_prefs (user_id)
values ('reza')
on conflict (user_id) do nothing;
