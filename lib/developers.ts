// The single canonical allow-list of real developers this app is permitted
// to show. Every adapter's id/name is validated against this at module load
// (lib/adapters/index.ts), and the database prunes any row whose sourceId
// isn't in it (lib/db.ts) — so this file, not the adapter code, is the
// actual authority on which sources may ever appear.
//
// The file's own `_meta.rules` (reproduced below for anyone reading this
// file without opening the JSON) are enforced as follows:
//
//   1. "Every listing's source label must be the real developer name from
//      this file." — lib/adapters/index.ts refuses to register any adapter
//      whose `name` doesn't exactly match its entry here.
//   2. "No fabricated listings, prices, areas, postcodes, images, or
//      sources." — no adapter in this codebase generates synthetic data;
//      developers without real scraping logic get an honest stub
//      (lib/adapters/stub.ts) that always throws instead of inventing one.
//   3. "If an adapter fails or is blocked, return empty and log to
//      sync_status — do not invent data." — lib/syncEngine.ts's try/catch
//      records the real failure (0 listings + the real error/classification)
//      for every adapter; nothing ever falls back to placeholder data.
//
// Note: the file's `aggregators` array (Rightmove, WhatHouse, Share to Buy,
// etc.) is intentionally never read here — rule #1's own description says
// sources are ONLY developers' own sites, never third-party portals.
import fs from "node:fs";
import path from "node:path";

export interface DeveloperEntry {
  id: string;
  name: string;
  segment?: string;
  website: string;
  listings_url: string;
  tenures?: string[];
  on_portals?: boolean | string;
  off_portal_value?: string;
  priority?: number;
  verify?: boolean;
  notes?: string;
  /** "aggregator" for a real third-party listing site (1newhomes, Benhams —
   * not the developer's own site); "estate-agent" for a general estate
   * agent whose stock is predominantly resale (Winkworth), where only
   * genuinely new-build listings are kept; absent/undefined means a direct
   * developer source. See lib/adapters/dedupe.ts for what this drives. */
  source_type?: "aggregator" | "estate-agent";
  /** When true, this source's own new-build discard filter is bypassed
   * entirely — every listing the adapter collects is kept and stored with
   * `isNewBuild: true`, no per-listing signal-checking at all. For a source
   * whose page/section is already curated as new-build-only by the site
   * itself (e.g. Winkworth's dedicated new-homes-for-sale section), so a
   * text-based safety-net filter does more harm (false negatives from
   * listings that don't happen to use one of the checked phrases) than good.
   * Absent/undefined (the default) means the source's own filter, if any,
   * still applies. See trustsAsNewBuild() below. */
  trustAsNewBuild?: boolean;
}

interface DeveloperListFile {
  _meta?: { rules?: string[]; [key: string]: unknown };
  developers: DeveloperEntry[];
  aggregators?: unknown[];
}

const filePath = path.join(process.cwd(), "london-developers.json");
const raw = fs.readFileSync(filePath, "utf-8");
const parsed: unknown = JSON.parse(raw);

if (
  typeof parsed !== "object" ||
  parsed === null ||
  !Array.isArray((parsed as DeveloperListFile).developers)
) {
  throw new Error('london-developers.json must contain a "developers" array.');
}

const file = parsed as DeveloperListFile;

export const DEVELOPER_LIST_RULES: string[] = file._meta?.rules ?? [];
export const ALLOWED_DEVELOPERS: DeveloperEntry[] = file.developers;
export const ALLOWED_DEVELOPER_IDS = new Set(ALLOWED_DEVELOPERS.map((d) => d.id));
export const ALLOWED_DEVELOPER_NAMES = new Map(ALLOWED_DEVELOPERS.map((d) => [d.id, d.name]));
export const ALLOWED_DEVELOPERS_BY_ID = new Map(ALLOWED_DEVELOPERS.map((d) => [d.id, d]));

/** True if this developer id's registry entry is tagged `source_type:
 * "aggregator"` — a real third-party listing site, not a developer's own
 * site. Used by lib/syncEngine.ts to decide whether a source's listings go
 * through dedupe.ts before being stored. */
export function isAggregatorSource(developerId: string): boolean {
  return ALLOWED_DEVELOPERS_BY_ID.get(developerId)?.source_type === "aggregator";
}

/** True if this developer id's registry entry is tagged `source_type:
 * "estate-agent"` — a general estate agent whose stock is predominantly
 * resale (Winkworth), where the adapter itself already discards anything
 * without a genuine new-build signal (see hasExplicitNewBuildSignal in
 * lib/adapters/newBuildDetection.ts) before a listing ever reaches here. */
export function isEstateAgentSource(developerId: string): boolean {
  return ALLOWED_DEVELOPERS_BY_ID.get(developerId)?.source_type === "estate-agent";
}

/** True if this developer id's registry entry is tagged
 * `trustAsNewBuild: true` — the source's own adapter should skip its
 * new-build discard filter entirely and keep every listing it collects,
 * marked `isNewBuild: true` with no per-listing signal-checking. See
 * DeveloperEntry.trustAsNewBuild above for when this is appropriate. */
export function trustsAsNewBuild(developerId: string): boolean {
  return ALLOWED_DEVELOPERS_BY_ID.get(developerId)?.trustAsNewBuild === true;
}

/** True if this source's listings should run in the sync engine's second
 * phase (after every direct-developer source has finished) and be deduped
 * against direct-developer listings before storage — aggregators and
 * general estate agents alike, both non-direct sources where a real
 * developer's own listing always wins. See runAllAdapters()/runOne() in
 * lib/syncEngine.ts. */
export function isSecondPhaseSource(developerId: string): boolean {
  return isAggregatorSource(developerId) || isEstateAgentSource(developerId);
}

/**
 * Persists a corrected `listings_url` for one developer directly into
 * london-developers.json on disk, so future syncs use it without needing
 * URL discovery to re-run (see lib/adapters/autoAdapter.ts). Edits the raw
 * file text with a targeted regex rather than re-serialising the whole
 * parsed object, so every other entry's exact formatting is left untouched
 * (each developer is currently one line — a full JSON.stringify re-indent
 * would otherwise turn this into a huge, unrelated diff).
 *
 * Returns false (and leaves the file untouched) if the developer's line
 * can't be found, or if the edit wouldn't parse as valid JSON — this is a
 * best-effort convenience, not something that should ever risk corrupting
 * the canonical developer list.
 */
export function updateListingsUrlInFile(developerId: string, newListingsUrl: string): boolean {
  const currentRaw = fs.readFileSync(filePath, "utf-8");
  const escapedId = developerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`("id":\\s*"${escapedId}"[^}]*?"listings_url":\\s*")[^"]*(")`);

  if (!pattern.test(currentRaw)) return false;

  const updated = currentRaw.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${newListingsUrl}${suffix}`);

  try {
    JSON.parse(updated); // sanity check before touching disk — never write invalid JSON
  } catch {
    return false;
  }

  fs.writeFileSync(filePath, updated, "utf-8");
  return true;
}
