-- Adds removed_at to listings — the timestamp of the sync run that FIRST
-- noticed a listing had disappeared from its source (i.e. the moment
-- lib/listingsStore.ts's upsertListingsForSource flips it to active =
-- false), for the public "Removed items" page.
--
-- Nullable, and deliberately left null for every row already inactive
-- before this migration runs: this app never previously recorded when a
-- listing went inactive, only that it had, so there is no real removal
-- date to backfill for those — leaving them null (and excluding them from
-- the Removed items page, which only shows rows with a real removed_at) is
-- the honest choice, not a guess like "today" or last_seen_at (which is
-- when it was last seen ACTIVE, not when its removal was detected).
-- Every removal from this point forward gets a real, accurate timestamp.

alter table listings add column if not exists removed_at timestamptz;

-- Powers "currently-removed listings, most-recent first, since <cutoff>" —
-- the exact query the Removed items page runs (lib/removedListingsQuery.ts).
create index if not exists idx_listings_removed_at
  on listings (removed_at desc)
  where active = false;
