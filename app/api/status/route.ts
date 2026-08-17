import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adapters } from "@/lib/adapters";
import { runAllAdapters } from "@/lib/syncEngine";
import { deriveEffectiveStatus } from "@/lib/statusDerive";
import type { StatusResponse, StoredSourceStatus, SyncStatusRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SyncStatusDbRow {
  sourceId: string;
  sourceName: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  status: StoredSourceStatus;
  httpStatus: number | null;
  listingsFound: number;
  added: number;
  updated: number;
  removed: number;
  durationMs: number | null;
  errorMessage: string | null;
  extractionMethod: string | null;
}

async function ensureInitialSyncHasRun(): Promise<void> {
  const ids = adapters.map((a) => a.id);
  const placeholders = ids.map(() => "?").join(",");
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM sync_status WHERE sourceId IN (${placeholders})`)
    .get(...ids) as unknown as { n: number };
  // Runs on first-ever load, and again whenever a new adapter has been added
  // to the registry but has no row yet (e.g. after this deploy).
  if (row.n < ids.length) {
    await runAllAdapters();
  }
}

export async function GET() {
  await ensureInitialSyncHasRun();

  const rows = db
    .prepare(`SELECT * FROM sync_status ORDER BY sourceName ASC`)
    .all() as unknown as SyncStatusDbRow[];

  const sources: SyncStatusRow[] = rows.map((r) => ({
    sourceId: r.sourceId,
    sourceName: r.sourceName,
    lastRunAt: r.lastRunAt,
    lastSuccessAt: r.lastSuccessAt,
    storedStatus: r.status,
    status: deriveEffectiveStatus(r.status, r.lastSuccessAt),
    httpStatus: r.httpStatus,
    listingsFound: r.listingsFound,
    added: r.added,
    updated: r.updated,
    removed: r.removed,
    durationMs: r.durationMs,
    errorMessage: r.errorMessage,
    extractionMethod: r.extractionMethod,
  }));

  const summary = {
    ok: 0,
    no_results: 0,
    blocked: 0,
    error: 0,
    stale: 0,
    not_built: 0,
    total: sources.length,
  };
  for (const s of sources) summary[s.status] += 1;

  const body: StatusResponse = { sources, summary };
  return NextResponse.json(body);
}
