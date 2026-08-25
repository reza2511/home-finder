import type { StatusResponse } from "./types";

export type { StatusResponse, SyncStatusRow, StatusSummary, SourceStatus } from "./types";

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load source status (${res.status})`);
  }
  return res.json();
}

interface SourcesResponse {
  sources: { id: string; name: string }[];
}

async function fetchAllSourceIds(): Promise<string[]> {
  const res = await fetch("/api/sources", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load the source list (${res.status})`);
  }
  const body: SourcesResponse = await res.json();
  return body.sources.map((s) => s.id);
}

/** One source's outcome from a triggerSync() run — surfaced to the caller
 * so the UI can show real per-source progress/failures rather than a
 * single opaque "done" at the end. */
export interface SyncProgress {
  sourceId: string;
  index: number;
  total: number;
  ok: boolean;
  error?: string;
}

/**
 * Runs a full sync from the browser — one POST /api/sync?ids=<id> request
 * PER source, strictly sequential, the same one-at-a-time sequencing
 * scripts/run-sync.ts already uses for the GitHub Actions cron (see that
 * script's own `main()` loop). Not one big "sync everything" request: that
 * used to be a single POST with no `ids`, which reliably exceeded Vercel's
 * request duration limit partway through an 18-source run and got hard-
 * killed by the platform (504) — see app/api/sync/route.ts's own doc
 * comment for the incident this traces back to. That route now rejects
 * anything but exactly one id per request, so this is the only shape of
 * call that still works.
 *
 * `onProgress`, if given, fires after every source (success or failure) —
 * a fetch that itself times out or 409s (a lock held by another sync) is
 * caught and reported as a failure for that one source, same as
 * scripts/run-sync.ts logging a per-source failure and moving on, rather
 * than aborting the whole walk over one source having a bad request.
 */
export async function triggerSync(onProgress?: (p: SyncProgress) => void): Promise<void> {
  const ids = await fetchAllSourceIds();
  const errors: string[] = [];

  for (const [index, id] of ids.entries()) {
    try {
      const res = await fetch(`/api/sync?ids=${encodeURIComponent(id)}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed to sync ${id} (${res.status})`);
      }
      onProgress?.({ sourceId: id, index, total: ids.length, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${id}: ${message}`);
      onProgress?.({ sourceId: id, index, total: ids.length, ok: false, error: message });
    }
  }

  // Only fail the whole call if EVERY source failed — the actual signal of
  // something catastrophic (e.g. every request rejected by the same held
  // lock) rather than one source having a bad run, mirroring
  // scripts/run-sync.ts's own exit-code reasoning.
  if (ids.length > 0 && errors.length === ids.length) {
    throw new Error(errors[0]);
  }
}
