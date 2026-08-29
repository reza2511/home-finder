/**
 * Property Tracker display preferences — a page-wide UI setting ("Don't
 * show these again" for the read-error indicator icons), not data about any
 * one property row, so it lives in its own single-row-per-user table
 * (supabase/migrations/0017_tracker_prefs.sql) rather than a column on
 * property_tracker. Same "service_role only, no public RLS policy" access
 * shape as lib/trackerStore.ts — only reachable from a route that's already
 * checked isAuthenticated() (app/api/tracker/prefs/route.ts).
 */
import { requireSupabaseAdmin } from "./db";
import { FIXED_USER_ID } from "./trackerStore";
import type { TrackerPrefs } from "./trackerTypes";

interface TrackerPrefsRow {
  hide_extraction_notes: boolean;
}

/** Defaults to { hideExtractionNotes: false } if the row is somehow
 * missing (should never happen — the migration seeds it — but a
 * maybeSingle() read defends against it rather than throwing over a
 * missing preference row). */
export async function getTrackerPrefs(): Promise<TrackerPrefs> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("property_tracker_prefs")
    .select("hide_extraction_notes")
    .eq("user_id", FIXED_USER_ID)
    .maybeSingle<TrackerPrefsRow>();
  if (error) throw new Error(`getTrackerPrefs: read failed: ${error.message}`);
  return { hideExtractionNotes: data?.hide_extraction_notes ?? false };
}

export async function setTrackerPrefs(patch: Partial<TrackerPrefs>): Promise<TrackerPrefs> {
  const admin = requireSupabaseAdmin();

  const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.hideExtractionNotes === "boolean") {
    dbPatch.hide_extraction_notes = patch.hideExtractionNotes;
  }

  const { data, error } = await admin
    .from("property_tracker_prefs")
    .upsert({ user_id: FIXED_USER_ID, ...dbPatch }, { onConflict: "user_id" })
    .select("hide_extraction_notes")
    .single<TrackerPrefsRow>();
  if (error || !data) throw new Error(`setTrackerPrefs: upsert failed: ${error?.message ?? "no row returned"}`);
  return { hideExtractionNotes: data.hide_extraction_notes };
}
