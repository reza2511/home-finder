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
