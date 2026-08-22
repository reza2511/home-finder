-- Adds bathrooms/parking/floor columns for the property-card icon-attribute
-- row (bedrooms already existed). All three are nullable and populated only
-- when an adapter's source actually states a real per-listing value for
-- that field (see lib/adapters/types.ts) — never guessed/derived, so most
-- existing rows will simply stay null until re-synced. Additive and safe to
-- re-run.

alter table listings add column if not exists bathrooms integer;
alter table listings add column if not exists parking integer;
alter table listings add column if not exists floor integer;
