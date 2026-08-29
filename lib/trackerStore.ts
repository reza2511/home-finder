/**
 * Property Tracker CRUD — private to the app's single operator account, same
 * "service_role only, no anon/authenticated RLS policy at all" shape as
 * lib/favouritesStore.ts (see supabase/migrations/0014_property_tracker.sql).
 * Every function here is only ever called from a route that's already
 * checked isAuthenticated() (app/api/tracker/*) — there's no public RLS
 * policy on either table, so that check is genuinely the only access path.
 */
import { requireSupabaseAdmin } from "./db";
import { extractTrackerFieldsFromUrl } from "./trackerExtract";
import type { TrackerRow, TrackerRowPatch } from "./trackerTypes";

export const FIXED_USER_ID = "reza"; // the one account lib/auth.ts ever authenticates

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
  awaiting_agent_call: boolean;
  interested: boolean;
  extraction_note: string | null;
  created_at: string;
  updated_at: string;
}

function fromDb(row: TrackerRowDb): TrackerRow {
  return {
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
    awaitingAgentCall: row.awaiting_agent_call,
    interested: row.interested,
    extractionNote: row.extraction_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS =
  "id, url, name, price, bedrooms, floor, developer, address, view_date, area, postcode, comment, video, rejected, viewed, contacted_agent, awaiting_agent_call, interested, extraction_note, created_at, updated_at";

/** Every tracker row for the fixed account, ordered so the table can render
 * them directly: not-rejected before rejected, each group oldest-added
 * first — rejected ones sit at the bottom, and unticking "Rejected" moves a
 * row back to its original spot rather than to the end of the list. */
export async function listTrackerRows(): Promise<TrackerRow[]> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("property_tracker")
    .select(SELECT_COLUMNS)
    .eq("user_id", FIXED_USER_ID)
    .order("rejected", { ascending: true })
    .order("created_at", { ascending: true })
    .returns<TrackerRowDb[]>();
  if (error) throw new Error(`listTrackerRows: read failed: ${error.message}`);
  return (data ?? []).map(fromDb);
}

/**
 * Creates a new tracker row for `url`: runs the same AI-extraction approach
 * as the compare page (lib/trackerExtract.ts) to fill in whatever the page
 * genuinely states, then inserts the row regardless of whether extraction
 * succeeded — a blocked/unreadable page still gets a row (blank AI fields,
 * `extractionNote` set) so the operator can fill it in by hand, per the
 * feature's own "never lose the URL" requirement.
 */
export async function createTrackerRow(url: string): Promise<TrackerRow> {
  const admin = requireSupabaseAdmin();

  const result = await extractTrackerFieldsFromUrl(url);
  const insertRow = {
    user_id: FIXED_USER_ID,
    url,
    name: result.status === "ok" ? (result.fields.name ?? "") : "",
    price: result.status === "ok" ? (result.fields.price ?? "") : "",
    bedrooms: result.status === "ok" ? (result.fields.bedrooms ?? "") : "",
    floor: result.status === "ok" ? (result.fields.floor ?? "") : "",
    developer: result.status === "ok" ? (result.fields.developer ?? "") : "",
    address: result.status === "ok" ? (result.fields.address ?? "") : "",
    area: result.status === "ok" ? (result.fields.area ?? "") : "",
    postcode: result.status === "ok" ? (result.fields.postcode ?? "") : "",
    extraction_note:
      result.status === "ok" ? (result.warning ?? null) : `Couldn't read this page — ${result.message}`,
  };

  const { data, error } = await admin
    .from("property_tracker")
    .insert(insertRow)
    .select(SELECT_COLUMNS)
    .single<TrackerRowDb>();
  if (error || !data) {
    throw new Error(`createTrackerRow: insert failed: ${error?.message ?? "no row returned"}`);
  }
  return fromDb(data);
}

const PATCH_KEY_TO_COLUMN: Record<keyof TrackerRowPatch, string> = {
  url: "url",
  name: "name",
  price: "price",
  bedrooms: "bedrooms",
  floor: "floor",
  developer: "developer",
  address: "address",
  viewDate: "view_date",
  area: "area",
  postcode: "postcode",
  comment: "comment",
  video: "video",
  rejected: "rejected",
  viewed: "viewed",
  contactedAgent: "contacted_agent",
  awaitingAgentCall: "awaiting_agent_call",
  interested: "interested",
};

/** Applies a hand-edit (any subset of TrackerRowPatch's fields) to one row —
 * the auto-save behind every editable cell/checkbox in the table. Only
 * whitelisted columns can ever be written this way (PATCH_KEY_TO_COLUMN),
 * so the API route's request body can never reach an arbitrary column. */
export async function updateTrackerRow(id: string, patch: TrackerRowPatch): Promise<TrackerRow> {
  const admin = requireSupabaseAdmin();

  const dbPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = PATCH_KEY_TO_COLUMN[key as keyof TrackerRowPatch];
    if (column) dbPatch[column] = value;
  }
  if (Object.keys(dbPatch).length === 0) {
    throw new Error("updateTrackerRow: no editable fields in patch.");
  }
  dbPatch.updated_at = new Date().toISOString();

  const { data, error } = await admin
    .from("property_tracker")
    .update(dbPatch)
    .eq("id", id)
    .eq("user_id", FIXED_USER_ID)
    .select(SELECT_COLUMNS)
    .maybeSingle<TrackerRowDb>();
  if (error) throw new Error(`updateTrackerRow(${id}): update failed: ${error.message}`);
  if (!data) throw new Error(`updateTrackerRow(${id}): no such row.`);
  return fromDb(data);
}

/** Returns whether a row actually existed to delete, so the route can
 * return a real 404 for an id that's already gone (double click, etc.) —
 * same convention as lib/historyStore.ts's deleteSnapshot. */
export async function deleteTrackerRow(id: string): Promise<boolean> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("property_tracker")
    .delete()
    .eq("id", id)
    .eq("user_id", FIXED_USER_ID)
    .select("id");
  if (error) throw new Error(`deleteTrackerRow(${id}): delete failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
