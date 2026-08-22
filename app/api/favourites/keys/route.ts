import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { listFavouriteKeys } from "@/lib/favouritesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lightweight companion to GET /api/favourites — just the
// `sourceId::externalId` keys, for every property card's heart icon to know
// its own favourited state without the main listings grid re-fetching each
// listing's full details a second time. Same login-only protection as
// every other favourites route.
export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in." }, { status: 401 });
  }

  try {
    const keys = await listFavouriteKeys();
    return NextResponse.json({ keys });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
