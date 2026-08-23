import type { Listing } from "./types";

export interface SourceBreakdownEntry {
  sourceId: string;
  sourceName: string;
  listingCount: number;
}

/** One entry per distinct source present in `listings`, sorted by name —
 * computed once from real listing rows, never guessed or estimated. Shared
 * by lib/historyStore.ts (each refresh-history snapshot's own breakdown)
 * and lib/statsStore.ts (each day's stats snapshot) so both compute "how
 * many listings per source" the exact same way. */
export function summarizeBySource(listings: Listing[]): SourceBreakdownEntry[] {
  const counts = new Map<string, { sourceName: string; listingCount: number }>();
  for (const listing of listings) {
    const existing = counts.get(listing.sourceId);
    if (existing) {
      existing.listingCount++;
    } else {
      counts.set(listing.sourceId, { sourceName: listing.sourceName, listingCount: 1 });
    }
  }
  return [...counts.entries()]
    .map(([sourceId, v]) => ({ sourceId, sourceName: v.sourceName, listingCount: v.listingCount }))
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}
