import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import type { SyncEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface SyncEventRowDb {
  id: string;
  created_at: string;
  event_type: SyncEvent["eventType"];
  source_id: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

/**
 * The audit trail of every automatic action the sync machinery has taken
 * (supabase/migrations/0013_reliability.sql's sync_events_log — see
 * lib/dropGuard.ts's logSyncEvent, the only writer): a drop-guard
 * rejection, a one-shot auto-retry of a transiently-failed source, or an
 * auto-clear of a stale sync lock. Read by the Status Monitor's
 * "Auto-actions" panel and, indirectly, by the health sign's detail view.
 * Public read, same as GET /api/status and GET /api/sync-history — this is
 * operational history, not anything sensitive.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitParam = Number(searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const { data, error } = await supabase
    .from("sync_events_log")
    .select("id, created_at, event_type, source_id, message, details")
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<SyncEventRowDb[]>();
  if (error) {
    return NextResponse.json({ error: `Failed to read sync_events_log from Supabase: ${error.message}` }, { status: 500 });
  }

  const events: SyncEvent[] = (data ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    eventType: r.event_type,
    sourceId: r.source_id,
    message: r.message,
    details: r.details,
  }));
  return NextResponse.json({ events });
}
