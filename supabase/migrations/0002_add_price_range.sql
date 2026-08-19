-- Adds the price-range column used by adapters that publish a starting
-- price alongside a full published range (Berkeley, L&Q, Fairview New
-- Homes, Peabody New Homes) — this didn't exist yet when 0001_init.sql was
-- written; additive and safe to re-run.

alter table listings add column if not exists price_range text;
