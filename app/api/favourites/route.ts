import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { addFavourite, listFavourites, listRecentRemovals, removeFavourite } from "@/lib/favouritesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Private — same real, server-side session check as every other protected
// route (POST /api/sync, POST /api/history/capture). No public RLS policy
// backs favourites/favourite_removals either (see supabase/migrations/
// 0006_favourites.sql), so this check is the only access path, not a
// front-end nicety layered on top of already-public data.
function requireAuth(): NextResponse | null {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in." }, { status: 401 });
  }
  return null;
}

export async function GET() {
  const denied = requireAuth();
  if (denied) return denied;

  try {
    const [favourites, removals] = await Promise.all([listFavourites(), listRecentRemovals()]);
    return NextResponse.json({ favourites, removals });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface FavouriteBody {
  sourceId?: unknown;
  externalId?: unknown;
}

export async function POST(request: Request) {
  const denied = requireAuth();
  if (denied) return denied;

  let body: FavouriteBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : null;
  const externalId = typeof body.externalId === "string" ? body.externalId : null;
  if (!sourceId || !externalId) {
    return NextResponse.json({ error: "sourceId and externalId are required." }, { status: 400 });
  }

  try {
    await addFavourite(sourceId, externalId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const denied = requireAuth();
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const sourceId = searchParams.get("sourceId");
  const externalId = searchParams.get("externalId");
  if (!sourceId || !externalId) {
    return NextResponse.json({ error: "sourceId and externalId query params are required." }, { status: 400 });
  }

  try {
    await removeFavourite(sourceId, externalId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
