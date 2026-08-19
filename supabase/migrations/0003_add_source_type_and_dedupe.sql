-- Adds source_type to `listings` (distinguishes a direct developer's own
-- site from a real third-party aggregator site like 1newhomes/Benhams —
-- see london-developers.json's source_type field and lib/adapters/dedupe.ts)
-- and deduped_count to `sync_status` (how many of an aggregator's listings
-- were dropped this run because a direct-developer source already covers
-- them). Additive, safe to re-run.

alter table listings add column if not exists source_type text not null default 'developer';
alter table sync_status add column if not exists deduped_count integer not null default 0;

create index if not exists idx_listings_source_type on listings (source_type);
