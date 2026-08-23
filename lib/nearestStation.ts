/**
 * Nearest train/tube/DLR/tram station + straight-line distance, from a
 * listing's real coordinates (lib/geocoding.ts) against real station
 * locations (public/data/stations.json — see scripts/build-stations.mjs
 * for exactly where that data comes from and how it was built: the real,
 * free, open NaPTAN dataset, DfT/Open Government Licence).
 *
 * Distance is straight-line ("as the crow flies"), not a walking route —
 * cheap to compute for every listing against every station and a fair,
 * simple approximation; never presented as a walking distance.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Station {
  name: string;
  lat: number;
  lng: number;
}

export interface NearestStationResult {
  name: string;
  distanceMiles: number;
}

let cachedStations: Station[] | null = null;

function loadStations(): Station[] {
  if (cachedStations) return cachedStations;
  const filePath = path.join(process.cwd(), "public", "data", "stations.json");
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as { name: string; lat: number; lon: number }[];
  cachedStations = raw.map((s) => ({ name: s.name, lat: s.lat, lng: s.lon }));
  return cachedStations;
}

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle (haversine) distance between two points, in miles. */
export function haversineDistanceMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/** The real station nearest to (lat, lng), with its real straight-line
 * distance rounded to 1 decimal mile — or null if the station list
 * couldn't be loaded (never a guessed/fallback station). */
export function findNearestStation(point: { lat: number; lng: number }): NearestStationResult | null {
  const stations = loadStations();
  if (stations.length === 0) return null;

  let best: Station | null = null;
  let bestDistance = Infinity;
  for (const station of stations) {
    const d = haversineDistanceMiles(point, station);
    if (d < bestDistance) {
      bestDistance = d;
      best = station;
    }
  }
  if (!best) return null;

  return { name: best.name, distanceMiles: Math.round(bestDistance * 10) / 10 };
}
