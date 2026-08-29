/**
 * Property Tracker daily backups — a full snapshot of every property_tracker
 * row, captured once a day by Vercel Cron (GET /api/cron/tracker-backup,
 * see vercel.json) and stored separately in property_tracker_backups
 * (supabase/migrations/0014_property_tracker.sql). Upserts on (user_id,
 * date): a re-capture the same day just refreshes that day's row, but every
 * earlier day is left untouched, so "something went wrong with today's
 * edits" still has yesterday's (and every prior day's) good snapshot to
 * restore from — same reasoning as lib/statsStore.ts's daily snapshots.
 *
 * Private, not public — same access shape as lib/trackerStore.ts: only the
 * service_role client, from routes that have already checked isAuthenticated()
 * (or, for the cron route, the CRON_SECRET header) themselves.
 */
import { requireSupabaseAdmin } from "./db";
import { FIXED_USER_ID } from "./trackerStore";
import type { TrackerBackupSummary, TrackerRow } from "./trackerTypes";

interface TrackerRowDb {
  id: string;
  url: string;
  name: string;
  price: string;
  bedrooms: string;
  floor: string;
  developer: string;
  address: string;
  view_date: string | null;
  area: string;
  postcode: string;
  comment: string;
  video: string;
  rejected: boolean;
  viewed: boolean;
  contacted_agent: boolean;
  extraction_note: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS =
  "id, url, name, price, bedrooms, floor, developer, address, view_date, area, postcode, comment, video, rejected, viewed, contacted_agent, extraction_note, created_at, updated_at";

/** Captures every current property_tracker row into today's (UTC)
 * backup row, upserting on (user_id, date). Used by both the daily cron and
 * (if ever needed) an on-demand capture — mirrors lib/historyStore.ts's
 * captureSnapshotNow() in spirit, but keyed by calendar date rather than
 * kept-most-recent-N, since this is meant to be a permanent recovery trail,
 * not a rolling window. */
export async function captureTrackerBackupNow(): Promise<TrackerBackupSummary> {
  const admin = requireSupabaseAdmin();

  const { data: rows, error: readErr } = await admin
    .from("property_tracker")
    .select(SELECT_COLUMNS)
    .eq("user_id", FIXED_USER_ID)
    .returns<TrackerRowDb[]>();
  if (readErr) throw new Error(`captureTrackerBackupNow: failed to read property_tracker: ${readErr.message}`);

  const today = new Date().toISOString().slice(0, 10); // UTC calendar date, YYYY-MM-DD

  const { data: backup, error: upsertErr } = await admin
    .from("property_tracker_backups")
    .upsert(
      { user_id: FIXED_USER_ID, date: today, rows: rows ?? [] },
      { onConflict: "user_id,date" }
    )
    .select("date, captured_at")
    .single<{ date: string; captured_at: string }>();
  if (upsertErr || !backup) {
    throw new Error(`captureTrackerBackupNow: upsert failed: ${upsertErr?.message ?? "no row returned"}`);
  }

  return { date: backup.date, capturedAt: backup.captured_at, rowCount: (rows ?? []).length };
}

interface BackupSummaryRow {
  date: string;
  captured_at: string;
  rows: unknown;
}

/** Every backup's date/capture-time/row-count, most recent first — never
 * the full row payload (that would defeat the point of a lightweight list;
 * see restoreTrackerBackup for actually recovering one). */
export async function listTrackerBackups(): Promise<TrackerBackupSummary[]> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("property_tracker_backups")
    .select("date, captured_at, rows")
    .eq("user_id", FIXED_USER_ID)
    .order("date", { ascending: false })
    .returns<BackupSummaryRow[]>();
  if (error) throw new Error(`listTrackerBackups: read failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    date: r.date,
    capturedAt: r.captured_at,
    rowCount: Array.isArray(r.rows) ? r.rows.length : 0,
  }));
}

/**
 * Replaces every current property_tracker row with whatever was captured in
 * the given date's backup — the actual recovery path behind "so if
 * something goes wrong I can recover it". Deliberately a full
 * delete-then-reinsert rather than a merge: a backup is a point-in-time copy
 * of the *whole* tracker, and merging would leave ambiguous which of two
 * conflicting edits should win. Reinserts with the SAME row ids the backup
 * recorded (rather than minting new ones) so this is safely re-runnable and
 * so a restored row's id stays stable across a restore.
 */
export async function restoreTrackerBackup(date: string): Promise<TrackerRow[]> {
  const admin = requireSupabaseAdmin();

  const { data: backup, error: readErr } = await admin
    .from("property_tracker_backups")
    .select("rows")
    .eq("user_id", FIXED_USER_ID)
    .eq("date", date)
    .maybeSingle<{ rows: TrackerRowDb[] }>();
  if (readErr) throw new Error(`restoreTrackerBackup(${date}): read failed: ${readErr.message}`);
  if (!backup) throw new Error(`restoreTrackerBackup(${date}): no backup exists for that date.`);

  const { error: deleteErr } = await admin.from("property_tracker").delete().eq("user_id", FIXED_USER_ID);
  if (deleteErr) throw new Error(`restoreTrackerBackup(${date}): failed to clear current rows: ${deleteErr.message}`);

  const backedUpRows = backup.rows ?? [];
  if (backedUpRows.length > 0) {
    const { error: insertErr } = await admin.from("property_tracker").insert(
      backedUpRows.map((r) => ({
        id: r.id,
        user_id: FIXED_USER_ID,
        url: r.url,
        name: r.name,
        price: r.price,
        bedrooms: r.bedrooms,
        floor: r.floor,
        developer: r.developer,
        address: r.address,
        view_date: r.view_date,
        area: r.area,
        postcode: r.postcode,
        comment: r.comment,
        video: r.video,
        rejected: r.rejected,
        viewed: r.viewed,
        contacted_agent: r.contacted_agent,
        extraction_note: r.extraction_note,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    );
    if (insertErr) throw new Error(`restoreTrackerBackup(${date}): failed to reinsert rows: ${insertErr.message}`);
  }

  const { data: restored, error: reReadErr } = await admin
    .from("property_tracker")
    .select(SELECT_COLUMNS)
    .eq("user_id", FIXED_USER_ID)
    .order("rejected", { ascending: true })
    .order("created_at", { ascending: true })
    .returns<TrackerRowDb[]>();
  if (reReadErr) throw new Error(`restoreTrackerBackup(${date}): re-read failed: ${reReadErr.message}`);

  return (restored ?? []).map((row) => ({
    id: row.id,
    url: row.url,
    name: row.name,
    price: row.price,
    bedrooms: row.bedrooms,
    floor: row.floor,
    developer: row.developer,
    address: row.address,
    viewDate: row.view_date,
    area: row.area,
    postcode: row.postcode,
    comment: row.comment,
    video: row.video,
    rejected: row.rejected,
    viewed: row.viewed,
    contactedAgent: row.contacted_agent,
    extractionNote: row.extraction_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
