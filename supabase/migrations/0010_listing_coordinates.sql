-- Adds real geographic coordinates to listings, for the "nearest station"
-- feature on each card (see lib/geocoding.ts, lib/nearestStation.ts).
--
-- No source adapter publishes lat/lng directly, so these are derived from
-- each listing's own real, already-stored postcode via postcodes.io (free,
-- MIT-licensed, built on Ordnance Survey + ONS open data — see
-- lib/geocoding.ts's own header) at sync time — a real, deterministic
-- geocode of real data, not a guess. Nullable and left null for any
-- listing with no postcode, or a postcode postcodes.io doesn't recognise
-- (a very new build not yet in ONS's data, or simply not a real postcode)
-- — the nearest-station feature leaves those blank rather than guessing.

alter table listings add column if not exists lat double precision;
alter table listings add column if not exists lng double precision;
