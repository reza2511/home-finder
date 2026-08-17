import type { DeveloperEntry } from "../developers";
import { AdapterNotBuiltError, type AdapterRunResult, type SourceAdapter } from "./types";

/**
 * A stub for a developer listed in london-developers.json that doesn't have
 * real scraping logic yet. Per the file's _meta.rules #3 ("if an adapter
 * fails ... return empty and log to sync_status — do not invent data"), it
 * always throws rather than ever returning a fabricated listing. The sync
 * engine classifies this as `not_built` — a known, expected gap, kept
 * distinct in the Status Monitor from `error` (a real adapter that actually
 * tried and failed).
 */
export function createStubAdapter(developer: DeveloperEntry): SourceAdapter {
  return {
    id: developer.id,
    name: developer.name,
    async run(): Promise<AdapterRunResult> {
      throw new AdapterNotBuiltError(
        `No scraping logic has been written yet for "${developer.name}" ` +
          `(${developer.listings_url || developer.website}). Returning no ` +
          `listings rather than fabricating any — see london-developers.json.`
      );
    },
  };
}
