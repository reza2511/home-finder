import { NextResponse } from "next/server";
import { runAllAdapters } from "@/lib/syncEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Triggers a manual sync of every registered source adapter (or, with
// ?ids=a,b,c, just those — useful for retrying a handful of sources without
// re-queuing everything behind the shared Playwright render-concurrency
// limit). In production this same function would also be invoked on a 12h
// schedule (cron / queue worker); here it's exposed so the Status Monitor's
// "Run sync now" button can trigger it on demand.
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get("ids");
  const ids = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const startedAt = Date.now();
  await runAllAdapters(ids);
  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sources: ids ?? "all",
  });
}
