/**
 * Real UK postcode -> real coordinates, via postcodes.io
 * (https://postcodes.io) — free, MIT-licensed, open source
 * (https://github.com/ideal-postcodes/postcodes.io), built on Ordnance
 * Survey and Office for National Statistics open data. No API key. Used
 * to derive `listings.lat`/`listings.lng` (supabase/migrations/0010_
 * listing_coordinates.sql) from each listing's own real, already-stored
 * postcode — never a guess: a postcode that doesn't resolve (not
 * recognised, or no postcode stated) simply gets no coordinates, and the
 * nearest-station feature (lib/nearestStation.ts) leaves that listing
 * blank rather than estimating.
 */

export interface Coordinates {
  lat: number;
  lng: number;
}

interface BulkLookupResult {
  query: string;
  result: { latitude: number; longitude: number } | null;
}

// postcodes.io's bulk endpoint caps each request at 100 postcodes.
const BULK_BATCH_SIZE = 100;

/**
 * Geocodes every distinct postcode in `postcodes` (full or outward-only —
 * postcodes.io accepts both) via postcodes.io's bulk lookup, batched at
 * 100 per request. Returns a Map keyed by the exact input string (not
 * normalized) to whatever coordinates were found — a postcode with no
 * match simply has no entry, never a fabricated one.
 */
export async function geocodePostcodes(postcodes: string[]): Promise<Map<string, Coordinates>> {
  const results = new Map<string, Coordinates>();
  const distinct = [...new Set(postcodes.map((p) => p.trim()).filter(Boolean))];

  for (let i = 0; i < distinct.length; i += BULK_BATCH_SIZE) {
    const batch = distinct.slice(i, i + BULK_BATCH_SIZE);
    let data: { result?: BulkLookupResult[] };
    try {
      const res = await fetch("https://api.postcodes.io/postcodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postcodes: batch }),
      });
      if (!res.ok) {
        console.warn(`[geocoding] postcodes.io bulk lookup failed: HTTP ${res.status} — skipping this batch`);
        continue;
      }
      data = await res.json();
    } catch (err) {
      // Network hiccup — best-effort. Listings in this batch just stay
      // ungeocoded (lat/lng null) rather than failing the whole sync.
      console.warn(`[geocoding] postcodes.io request failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const entry of data.result ?? []) {
      if (entry.result) {
        results.set(entry.query, { lat: entry.result.latitude, lng: entry.result.longitude });
      }
    }
  }

  return results;
}
