-- Adds the Property Tracker's "Name" and "Video" columns
-- (supabase/migrations/0014_property_tracker.sql's original table). Both
-- text, default '' — same "empty string not null, never null" convention
-- every other tracker text column already uses (see that migration's own
-- comment on why: the UI never has to special-case null vs empty string in
-- an editable input).
--
-- name: the property/development's own name — pre-filled by the AI-
-- extraction step when the pasted page states one (lib/trackerExtract.ts,
-- lib/trackerStructuredExtract.ts), left blank otherwise for the operator
-- to type themselves. Unlike price/bedrooms/etc, this is genuinely both
-- an extractable AND a manually-editable field.
--
-- video: a video link (YouTube, Google Drive, or any URL) the operator
-- pastes in themselves — never scraped, same as comment/view_date.

alter table property_tracker add column if not exists name text not null default '';
alter table property_tracker add column if not exists video text not null default '';
