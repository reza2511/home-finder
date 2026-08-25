import { NextResponse } from "next/server";
import { adapters } from "@/lib/adapters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The full, canonical list of registered source ids/names — straight from
 * the adapter registry (lib/adapters/index.ts, itself generated from
 * london-developers.json), NOT from sync_status. Deliberately not derived
 * from GET /api/status's rows: sync_status only ever holds a row for a
 * source that has actually run at least once, so a source with no row yet
 * (a fresh deploy, or — 2026-08-25 — one whose row was wiped by the
 * pruneUnknownSources bug this exists partly to help recover from) would
 * silently vanish from any list built that way. lib/statusClient.ts's
 * triggerSync() calls this to know the complete set of sources to walk
 * through, one POST /api/sync request per id, regardless of what
 * sync_status currently does or doesn't have a row for.
 *
 * No auth gate — this is a public list of source names/ids, same
 * information already visible in the public Status Monitor and Statistics
 * pages, not a privileged action like actually triggering a sync.
 */
export async function GET() {
  const sources = adapters.map((a) => ({ id: a.id, name: a.name }));
  return NextResponse.json({ sources });
}
