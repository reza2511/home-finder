import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every read route here (listings, status, sync-history, ...) is already
// `force-dynamic` with a `cache: "no-store"` Supabase client (lib/db.ts) —
// there is no Next.js Data/Route Cache actually serving stale listings
// today (see that file's own comment for the real incident that made this
// true). revalidatePath() below is a genuine, working purge anyway — it
// covers any cached entry for these paths if one is ever (re)introduced —
// but the main point of this endpoint is being the one real, deliberate
// action the header's "Clear cache" button can call: the client re-fetches
// listings/status right after this resolves, rather than a visitor just
// hoping the existing 60s status poll happens to catch a change soon.
// Public, same as the GET routes it revalidates — it only ever forces a
// fresh read, never touches data, so there's nothing to gate behind login.
export async function POST() {
  revalidatePath("/", "layout");
  revalidatePath("/api/listings");
  revalidatePath("/api/status");
  revalidatePath("/api/sync-history");
  return NextResponse.json({ ok: true, clearedAt: new Date().toISOString() });
}
