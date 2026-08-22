import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { extractPropertyFromUrl, type CompareResult } from "@/lib/compareExtract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each URL can need a full Playwright render (up to ~60s) plus an Anthropic
// call (up to ~45s) — see lib/compareExtract.ts. Same reasoning as
// app/api/sync/route.ts's maxDuration; actually capped by the Vercel plan.
export const maxDuration = 300;

const MAX_URLS = 10;
// A handful of URLs run concurrently rather than one giant Promise.all —
// each one can spin up its own Playwright context, and this is a page a
// logged-in operator can hit on demand (unlike the sync's own queued
// render concurrency limit, see autoAdapter.ts's MAX_CONCURRENT_RENDERS),
// so a modest cap here is just about not spiking memory on one request.
const MAX_CONCURRENT = 4;

interface CompareRequestBody {
  urls?: unknown;
}

async function runWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Real server-side auth gate, not a front-end nicety — same as POST
// /api/sync and GET /api/history. See lib/auth.ts.
export async function POST(request: Request) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: "Unauthorized — please log in to compare properties." }, { status: 401 });
  }

  let body: CompareRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const rawUrls = Array.isArray(body.urls) ? body.urls : [];
  const urls = rawUrls
    .filter((u): u is string => typeof u === "string" && u.trim() !== "")
    .map((u) => u.trim())
    .slice(0, MAX_URLS);

  if (urls.length === 0) {
    return NextResponse.json({ error: "No URLs provided." }, { status: 400 });
  }

  const results: CompareResult[] = await runWithConcurrencyLimit(urls, MAX_CONCURRENT, (url) =>
    extractPropertyFromUrl(url).catch(
      (err): CompareResult => ({
        url,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      })
    )
  );

  return NextResponse.json({ results });
}
