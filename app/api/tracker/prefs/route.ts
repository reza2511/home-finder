import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getTrackerPrefs, setTrackerPrefs } from "@/lib/trackerPrefsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const prefs = await getTrackerPrefs();
    return NextResponse.json({ prefs });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface PrefsBody {
  hideExtractionNotes?: unknown;
}

export async function PATCH(request: Request) {
  const denied = requireAuth();
  if (denied) return denied;

  let body: PrefsBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof body.hideExtractionNotes !== "boolean") {
    return NextResponse.json({ error: "hideExtractionNotes (boolean) is required." }, { status: 400 });
  }

  try {
    const prefs = await setTrackerPrefs({ hideExtractionNotes: body.hideExtractionNotes });
    return NextResponse.json({ prefs });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
