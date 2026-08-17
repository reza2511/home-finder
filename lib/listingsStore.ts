import { db } from "./db";
import type { AdapterListing } from "./adapters/types";

const getActiveStmt = db.prepare(
  `SELECT externalId FROM listings WHERE sourceId = ? AND active = 1`
);

const upsertListingStmt = db.prepare(`
  INSERT INTO listings
    (sourceId, externalId, title, price, priceValue, url, images, mainImage,
     bedrooms, bedroomType, tenure, isNewBuild, postcode, area, firstSeenAt, lastSeenAt, active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(sourceId, externalId) DO UPDATE SET
    title       = excluded.title,
    price       = excluded.price,
    priceValue  = excluded.priceValue,
    url         = excluded.url,
    images      = excluded.images,
    mainImage   = excluded.mainImage,
    bedrooms    = excluded.bedrooms,
    bedroomType = excluded.bedroomType,
    tenure      = excluded.tenure,
    isNewBuild  = excluded.isNewBuild,
    postcode    = excluded.postcode,
    area        = excluded.area,
    lastSeenAt  = excluded.lastSeenAt,
    active      = 1
`);

const deactivateStmt = db.prepare(
  `UPDATE listings SET active = 0 WHERE sourceId = ? AND externalId = ?`
);

export interface DiffResult {
  added: number;
  updated: number;
  removed: number;
}

/**
 * Upserts a source's freshly-fetched listings and diffs them against what was
 * previously active for that source. Any previously-active listing not
 * present in `incoming` is marked inactive ("removed"). A listing seen again
 * (present both before and after) counts as "updated" — this is a simple
 * re-seen count, not a field-level change diff.
 */
export function upsertListingsForSource(
  sourceId: string,
  incoming: AdapterListing[]
): DiffResult {
  const now = new Date().toISOString();
  const existing = getActiveStmt.all(sourceId) as unknown as {
    externalId: string;
  }[];
  const existingIds = new Set(existing.map((r) => r.externalId));
  const incomingIds = new Set(incoming.map((l) => l.externalId));

  let added = 0;
  let updated = 0;

  for (const listing of incoming) {
    if (existingIds.has(listing.externalId)) {
      updated += 1;
    } else {
      added += 1;
    }
    upsertListingStmt.run(
      sourceId,
      listing.externalId,
      listing.title,
      listing.price,
      listing.priceValue,
      listing.url,
      JSON.stringify(listing.images ?? []),
      listing.mainImage,
      listing.bedrooms,
      listing.bedroomType,
      listing.tenure,
      listing.isNewBuild ? 1 : 0,
      listing.postcode,
      listing.area,
      now,
      now
    );
  }

  let removed = 0;
  for (const id of existingIds) {
    if (!incomingIds.has(id)) {
      deactivateStmt.run(sourceId, id);
      removed += 1;
    }
  }

  return { added, updated, removed };
}
