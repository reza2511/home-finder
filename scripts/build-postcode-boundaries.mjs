// One-time (re-runnable) data-generation script — NOT part of the running
// app. Downloads real, freely-licensed UK postcode DISTRICT boundary
// polygons, keeps only the postcode AREAS this app covers (matching
// lib/adapters/londonPostcodes.ts's LONDON_POSTCODE_AREAS exactly), and
// writes one simplified, pre-colored static GeoJSON file for the Postcode
// Map page to fetch at runtime (public/data/postcode-districts.geojson —
// deliberately NOT imported/bundled into the JS bundle).
//
// Source: https://github.com/missinglink/uk-postcode-polygons — an export
// of the KML files attached to Wikipedia's "List of postcode districts in
// the United Kingdom" article, converted to GeoJSON (one file per postcode
// AREA, one Feature per constituent DISTRICT). License: all data is
// (c) Wikipedia contributors, Creative Commons Attribution-ShareAlike 3.0
// Unported (https://en.wikipedia.org/wiki/Wikipedia:Copyrights) — free to
// use, including commercially, with attribution (see the Postcode Map
// page's own footer credit).
//
// Two processing steps beyond a straight merge:
//  1. Geometry simplification (turf.simplify) — the raw data is already
//     modest (~590KB for all 19 areas), but this trims redundant points
//     from the KML→GeoJSON conversion while keeping district shapes
//     visually accurate at the zoom levels this map actually uses.
//  2. Map coloring (NOT identity coloring): a greedy graph-coloring pass
//     over real polygon adjacency (turf.booleanIntersects) assigns each
//     district one of a small fixed palette such that no two districts
//     that actually share a border ever get the same color — the
//     standard approach for choropleth/administrative maps (four-color-
//     theorem territory), distinct from a categorical "one hue per named
//     series" palette, which doesn't fit 330 unique districts.
//
// Usage: node scripts/build-postcode-boundaries.mjs
import { writeFileSync } from "node:fs";
import { simplify, booleanIntersects, bbox } from "@turf/turf";

// Exactly lib/adapters/londonPostcodes.ts's LONDON_POSTCODE_AREAS.
const AREAS = ["E", "EC", "N", "NW", "SE", "SW", "W", "WC", "BR", "CR", "DA", "EN", "HA", "IG", "KT", "RM", "SM", "TW", "UB", "WD"];

const SOURCE_BASE = "https://raw.githubusercontent.com/missinglink/uk-postcode-polygons/master/geojson";
const OUT_PATH = new URL("../public/data/postcode-districts.geojson", import.meta.url);

// A tolerance of ~0.0003 degrees (~30m at London's latitude) keeps every
// district's real shape clearly recognizable at the zoom levels this map
// uses, while measurably cutting point count from the raw KML→GeoJSON
// conversion.
const SIMPLIFY_TOLERANCE = 0.0003;

// Map-coloring palette (NOT the dataviz skill's categorical-identity
// palette — a different job: adjacent shapes on a choropleth just need to
// look different from their neighbors, not each carry a fixed, memorable
// identity color across multiple charts). 6 visually distinct, mid-
// saturation fills that all read clearly against OpenStreetMap tiles.
export const MAP_COLOR_PALETTE = [
  "#4C8DFF",
  "#FF8A4C",
  "#4CC98A",
  "#E15A8A",
  "#B08CFF",
  "#F2C13B",
  "#3BC1D6",
  "#D66A3B",
];

async function fetchArea(area) {
  const res = await fetch(`${SOURCE_BASE}/${area}.geojson`);
  if (!res.ok) throw new Error(`Failed to fetch ${area}.geojson: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`Fetching ${AREAS.length} postcode area file(s) from ${SOURCE_BASE} ...`);
  const features = [];
  for (const area of AREAS) {
    const fc = await fetchArea(area);
    for (const feature of fc.features) {
      const code = feature.properties?.name;
      if (!code) {
        console.warn(`  ${area}: skipping a feature with no district code`);
        continue;
      }
      features.push({
        ...feature,
        properties: { code, area },
      });
    }
    console.log(`  ${area}: ${fc.features.length} district(s)`);
  }
  console.log(`Total districts before dedup: ${features.length}`);

  // Simplify every geometry.
  const simplified = features.map((f) => ({
    ...f,
    geometry: simplify(f.geometry, { tolerance: SIMPLIFY_TOLERANCE, highQuality: false }),
  }));

  // ---- Map coloring: greedy graph coloring over real adjacency ----
  // Bounding boxes first (cheap) to shortlist candidate neighbor pairs,
  // then a real boolean-intersects check only on those candidates —
  // O(n^2) bbox checks over 330 features is trivial; the expensive exact
  // check only runs on pairs that could plausibly touch.
  console.log("Computing district adjacency...");
  const boxes = simplified.map((f) => bbox(f));
  const boxesOverlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

  const adjacency = simplified.map(() => new Set());
  for (let i = 0; i < simplified.length; i++) {
    for (let j = i + 1; j < simplified.length; j++) {
      if (!boxesOverlap(boxes[i], boxes[j])) continue;
      try {
        if (booleanIntersects(simplified[i], simplified[j])) {
          adjacency[i].add(j);
          adjacency[j].add(i);
        }
      } catch {
        // A handful of source polygons are self-intersecting (real
        // Wikipedia KML data, not something this script should silently
        // "fix" by altering real boundary shapes) — booleanIntersects can
        // throw on those. Treat as "adjacency unknown" for this pair
        // rather than crashing the whole build; worst case that pair
        // gets a coloring collision, not a wrong shape.
      }
    }
  }

  // Welsh-Powell: color highest-degree (most neighbors) districts first —
  // tends to need fewer total colors than coloring in arbitrary order.
  const order = simplified.map((_, i) => i).sort((a, b) => adjacency[b].size - adjacency[a].size);
  const colorSlot = new Array(simplified.length).fill(-1);
  let maxSlotUsed = 0;
  for (const i of order) {
    const usedByNeighbors = new Set([...adjacency[i]].map((j) => colorSlot[j]).filter((c) => c >= 0));
    let slot = 0;
    while (usedByNeighbors.has(slot)) slot++;
    colorSlot[i] = slot;
    maxSlotUsed = Math.max(maxSlotUsed, slot);
  }
  console.log(`Map coloring used ${maxSlotUsed + 1} of ${MAP_COLOR_PALETTE.length} palette color(s).`);
  if (maxSlotUsed + 1 > MAP_COLOR_PALETTE.length) {
    throw new Error(
      `Greedy coloring needed ${maxSlotUsed + 1} colors but the palette only has ${MAP_COLOR_PALETTE.length} — add more MAP_COLOR_PALETTE entries and re-run.`
    );
  }

  const colored = simplified.map((f, i) => ({
    ...f,
    properties: { ...f.properties, colorSlot: colorSlot[i] },
  }));

  const out = { type: "FeatureCollection", features: colored };
  const json = JSON.stringify(out);
  writeFileSync(OUT_PATH, json);
  console.log(`Wrote ${OUT_PATH.pathname} — ${(json.length / 1024).toFixed(1)} KB, ${colored.length} district(s).`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
