// One-time (re-runnable) data-generation script — NOT part of the running
// app. Downloads the real, free, open NaPTAN (National Public Transport
// Access Nodes) dataset — the UK's official register of every public
// transport access point, published by the Department for Transport under
// the Open Government Licence (https://www.gov.uk/government/publications
// /national-public-transport-access-node-schema, API docs:
// https://naptan.api.dft.gov.uk/swagger/index.html) — and writes one
// compact static file of real London-area rail/tube/DLR/tram station
// names and coordinates for the "nearest station" feature to fetch at
// runtime (public/data/stations.json — not bundled into the JS).
//
// Fetches the NATIONAL dataset (no ATCO-area filter) rather than just
// Greater London's own ATCO area (490): several stations genuinely nearest
// to listings in this app's outer postcode areas (e.g. Watford Junction,
// just over the Hertfordshire border) aren't tagged under ATCO 490 at all,
// so a bounding box around Greater London (with a buffer) is what actually
// determines coverage here, not administrative area codes.
//
// NaPTAN StopType filter: RLY/RSE (National Rail station / station
// entrance) and MET/TMU (Underground/DLR/tram station / access point) —
// the four types that represent real rail-type stations, not bus stops
// (BCT — the overwhelming majority of NaPTAN rows) or the other non-rail
// types (ferry, airport, taxi rank, etc.).
//
// Usage: node scripts/build-stations.mjs
import { writeFileSync } from "node:fs";

const SOURCE_URL = "https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv";
const OUT_PATH = new URL("../public/data/stations.json", import.meta.url);

// Greater London plus a buffer wide enough to catch stations just outside
// the M25 that are genuinely nearest to a listing in one of this app's
// outer postcode areas (Watford, Dartford, etc.).
const LAT_MIN = 51.2;
const LAT_MAX = 51.75;
const LON_MIN = -0.6;
const LON_MAX = 0.4;

const STATION_STOP_TYPES = new Set(["RLY", "RSE", "MET", "TMU"]);

// NaPTAN's CommonName for RLY/MET rows includes a mode suffix ("Datchet
// Rail Station", "Brent Cross Underground") that RSE/TMU rows don't
// ("Abbey Wood Station", "Colindale") — stripped here so every real name
// for the same physical station groups together and displays the same
// clean way regardless of which row type it came from.
const SUFFIXES_TO_STRIP = [
  "Rail Station",
  "Underground Station",
  "DLR Station",
  "Tram Stop",
  "Station",
  "Rail",
  "Underground",
  "DLR",
];

function normalizeStationName(rawName) {
  let name = rawName.trim();
  let changedThisPass = true;
  while (changedThisPass) {
    changedThisPass = false;
    for (const suffix of SUFFIXES_TO_STRIP) {
      const re = new RegExp(`\\s+${suffix}$`, "i");
      if (re.test(name)) {
        name = name.replace(re, "").trim();
        changedThisPass = true;
      }
    }
  }
  return name;
}

// Minimal CSV parser (handles quoted fields containing commas) — NaPTAN's
// CSV export has no library dependency worth adding for a one-time script.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function main() {
  console.log(`Fetching the national NaPTAN dataset from ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`NaPTAN fetch failed: HTTP ${res.status}`);
  const csvText = await res.text();
  console.log(`Downloaded ${(csvText.length / 1024 / 1024).toFixed(1)} MB.`);

  const rows = parseCSV(csvText);
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const iStopType = col("StopType");
  const iStatus = col("Status");
  const iName = col("CommonName");
  const iLat = col("Latitude");
  const iLon = col("Longitude");

  // Group by normalized (lowercased) name so the same real station appears
  // once even if NaPTAN has several rows for it (multiple entrances,
  // multiple modes) — the centroid of its own real points is a genuine,
  // non-fabricated representative location for it.
  const groups = new Map();
  let consideredRows = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < header.length) continue;
    if (r[iStatus] !== "active") continue;
    if (!STATION_STOP_TYPES.has(r[iStopType])) continue;
    const lat = parseFloat(r[iLat]);
    const lon = parseFloat(r[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) continue;

    consideredRows++;
    const displayName = normalizeStationName(r[iName]);
    if (!displayName) continue;
    const key = displayName.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: displayName, points: [] });
    groups.get(key).points.push([lat, lon]);
  }

  const stations = [...groups.values()]
    .map((g) => {
      const n = g.points.length;
      const lat = g.points.reduce((sum, p) => sum + p[0], 0) / n;
      const lon = g.points.reduce((sum, p) => sum + p[1], 0) / n;
      return { name: g.name, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`${consideredRows} real NaPTAN rail-type row(s) in the London area, grouped into ${stations.length} distinct station(s).`);

  const json = JSON.stringify(stations);
  writeFileSync(OUT_PATH, json);
  console.log(`Wrote ${OUT_PATH.pathname} — ${(json.length / 1024).toFixed(1)} KB.`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
