import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { ALLOWED_DEVELOPER_IDS } from "./developers";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "homefinder.sqlite");

declare global {
  // eslint-disable-next-line no-var
  var __homefinderDb: DatabaseSync | undefined;
}

function createDb(): DatabaseSync {
  const instance = new DatabaseSync(dbPath);

  instance.exec(`
    CREATE TABLE IF NOT EXISTS sync_status (
      sourceId       TEXT PRIMARY KEY,
      sourceName     TEXT NOT NULL,
      lastRunAt      TEXT,
      lastSuccessAt  TEXT,
      status         TEXT NOT NULL,
      httpStatus     INTEGER,
      listingsFound  INTEGER NOT NULL DEFAULT 0,
      added          INTEGER NOT NULL DEFAULT 0,
      updated        INTEGER NOT NULL DEFAULT 0,
      removed        INTEGER NOT NULL DEFAULT 0,
      durationMs     INTEGER,
      errorMessage   TEXT,
      extractionMethod TEXT
    );
  `);

  instance.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      sourceId    TEXT NOT NULL,
      externalId  TEXT NOT NULL,
      title       TEXT NOT NULL,
      price       TEXT NOT NULL,
      priceValue  INTEGER NOT NULL DEFAULT 0,
      url         TEXT NOT NULL,
      images      TEXT NOT NULL DEFAULT '[]',
      mainImage   TEXT,
      bedrooms    INTEGER,
      bedroomType TEXT,
      tenure      TEXT,
      isNewBuild  INTEGER NOT NULL DEFAULT 0,
      postcode    TEXT,
      area        TEXT,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt  TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (sourceId, externalId)
    );
  `);

  // Additive migration for dev databases created before the images/tenure/etc.
  // columns existed — safe to call every time, a no-op once the column exists.
  // Note: ADD COLUMN can't change an existing column's NOT NULL-ness, so a
  // pre-existing `bedrooms` column from an older schema stays NOT NULL here;
  // harmless for dev, where the database is disposable and gets wiped.
  const listingsColumns = [
    ["priceValue", "INTEGER NOT NULL DEFAULT 0"],
    ["images", "TEXT NOT NULL DEFAULT '[]'"],
    ["mainImage", "TEXT"],
    ["bedrooms", "INTEGER"],
    ["bedroomType", "TEXT"],
    ["tenure", "TEXT"],
    ["isNewBuild", "INTEGER NOT NULL DEFAULT 0"],
    ["postcode", "TEXT"],
    ["area", "TEXT"],
  ] as const;
  for (const [column, ddl] of listingsColumns) {
    ensureColumn(instance, "listings", column, ddl);
  }
  ensureColumn(instance, "sync_status", "extractionMethod", "TEXT");

  pruneUnknownSources(instance);

  return instance;
}

function ensureColumn(
  instance: DatabaseSync,
  table: string,
  column: string,
  ddl: string
): void {
  const columns = instance.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Deletes any sync_status/listings rows belonging to a sourceId that isn't in
 * london-developers.json — the canonical allow-list, checked directly rather
 * than via the adapter registry, so the database itself refuses to retain
 * rows for anything unapproved. Cleans up rows left behind by adapters that
 * were removed (e.g. the old mock sources). Safe to call on every startup.
 */
function pruneUnknownSources(instance: DatabaseSync): void {
  const validIds = [...ALLOWED_DEVELOPER_IDS];
  if (validIds.length === 0) return;
  const placeholders = validIds.map(() => "?").join(",");
  instance
    .prepare(`DELETE FROM sync_status WHERE sourceId NOT IN (${placeholders})`)
    .run(...validIds);
  instance
    .prepare(`DELETE FROM listings WHERE sourceId NOT IN (${placeholders})`)
    .run(...validIds);
}

// Reuse a single connection across Next.js dev-server hot reloads.
export const db = globalThis.__homefinderDb ?? (globalThis.__homefinderDb = createDb());
