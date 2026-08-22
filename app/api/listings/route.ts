import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { fetchActiveListings } from "@/lib/listingsQuery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Aggregated feed of currently-active listings across every source, for the
// main page grid. See lib/listingsQuery.ts for the shared query/pagination
// logic (also used by the refresh-history snapshot capture).
export async function GET() {
  const { listings, error } = await fetchActiveListings(supabase);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  return NextResponse.json({ listings });
}
