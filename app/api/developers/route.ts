import { NextResponse } from "next/server";
import { ALLOWED_DEVELOPERS } from "@/lib/developers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The canonical developer list (london-developers.json) for the homepage's
// developer filter checklist. Deliberately just id/name — everything else
// in DeveloperEntry is sourcing metadata the sidebar doesn't need, and
// `lib/developers.ts` reads the filesystem so this list can't be imported
// straight into a client component.
export async function GET() {
  const developers = ALLOWED_DEVELOPERS.map((d) => ({ id: d.id, name: d.name }));
  return NextResponse.json({ developers });
}
