import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { deleteTrackerRow, updateTrackerRow } from "@/lib/trackerStore";
import type { TrackerRowPatch } from "@/lib/trackerTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireAuth(): NextResponse | null {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in." }, { status: 401 });
  }
  return null;
}

const STRING_FIELDS = [
  "url",
  "name",
  "price",
  "bedrooms",
  "floor",
  "developer",
  "address",
  "area",
  "postcode",
  "comment",
  "video",
] as const;
const BOOL_FIELDS = ["rejected", "viewed", "contactedAgent", "awaitingAgentCall", "interested"] as const;

/** Builds a whitelisted patch from an arbitrary request body — any key
 * that isn't one of TrackerRowPatch's own fields, or that has the wrong
 * type, is silently dropped rather than erroring, since a debounced
 * auto-save can legitimately send just one changed field at a time. */
function parsePatch(body: Record<string, unknown>): TrackerRowPatch {
  const patch: TrackerRowPatch = {};
  for (const key of STRING_FIELDS) {
    if (typeof body[key] === "string") patch[key] = body[key] as string;
  }
  for (const key of BOOL_FIELDS) {
    if (typeof body[key] === "boolean") patch[key] = body[key] as boolean;
  }
  if ("viewDate" in body) {
    const v = body.viewDate;
    if (v === null || typeof v === "string") patch.viewDate = v;
  }
  return patch;
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const denied = requireAuth();
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const patch = parsePatch(body);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No editable fields in request body." }, { status: 400 });
  }

  try {
    const row = await updateTrackerRow(params.id, patch);
    return NextResponse.json({ row });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("no such row") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const denied = requireAuth();
  if (denied) return denied;

  try {
    const existed = await deleteTrackerRow(params.id);
    if (!existed) return NextResponse.json({ error: "No such row." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
