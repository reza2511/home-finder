-- Adds the Property Tracker's two remaining tick boxes
-- (supabase/migrations/0014_property_tracker.sql's original table).
--
-- awaiting_agent_call: tracked and saved like every other tick box, but
-- carries no row colour of its own — see components/PropertyTrackerTable.tsx
-- for how row colour is decided (rejected > interested > neither).
--
-- interested: when true (and the row isn't rejected), highlights the whole
-- row light orange — a second, lower-priority row colour alongside
-- "rejected" (red). Rejected always wins when a row is both.

alter table property_tracker add column if not exists awaiting_agent_call boolean not null default false;
alter table property_tracker add column if not exists interested boolean not null default false;
