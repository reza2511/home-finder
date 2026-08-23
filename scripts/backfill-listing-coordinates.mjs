// One-time (re-runnable, idempotent) backfill: geocodes every currently-
// active listing's real postcode into real lat/lng, for listings that
// existed before lib/listingsStore.ts started geocoding automatically on
// every sync (supabase/migrations/0010_listing_coordinates.sql). Safe to
// re-run any time — only touches rows where lat/lng is still null, and
// only ever writes a real postcodes.io result, never a guess.
//
// Usage: node --env-file=.env.local scripts/backfill-listing-coordinates.mjs
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const BULK_BATCH_SIZE = 100;

async function geocodePostcodes(postcodes) {
  const results = new Map();
  const distinct = [...new Set(postcodes.map((p) => p.trim()).filter(Boolean))];
  for (let i = 0; i < distinct.length; i += BULK_BATCH_SIZE) {
    const batch = distinct.slice(i, i + BULK_BATCH_SIZE);
    const res = await fetch("https://api.postcodes.io/postcodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postcodes: batch }),
    });
    if (!res.ok) {
      console.warn(`postcodes.io bulk lookup failed: HTTP ${res.status} — skipping this batch of ${batch.length}`);
      continue;
    }
    const data = await res.json();
    for (const entry of data.result ?? []) {
      if (entry.result) {
        results.set(entry.query, { lat: entry.result.latitude, lng: entry.result.longitude });
      }
    }
    console.log(`  geocoded batch ${i / BULK_BATCH_SIZE + 1}/${Math.ceil(distinct.length / BULK_BATCH_SIZE)} (${batch.length} postcodes)`);
  }
  return results;
}

async function main() {
  console.log("Fetching active listings with a postcode but no coordinates yet...");
  const { data: rows, error } = await admin
    .from("listings")
    .select("source_id, external_id, postcode")
    .eq("active", true)
    .is("lat", null)
    .not("postcode", "is", null)
    .neq("postcode", "");
  if (error) throw new Error(`Failed to read listings: ${error.message}`);

  console.log(`${rows.length} listing(s) need geocoding.`);
  if (rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const coordsByPostcode = await geocodePostcodes(rows.map((r) => r.postcode));
  console.log(`Resolved ${coordsByPostcode.size} distinct postcode(s) to real coordinates.`);

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const coords = coordsByPostcode.get(row.postcode.trim());
    if (!coords) {
      skipped++;
      continue;
    }
    const { error: updateErr } = await admin
      .from("listings")
      .update({ lat: coords.lat, lng: coords.lng })
      .eq("source_id", row.source_id)
      .eq("external_id", row.external_id);
    if (updateErr) {
      console.warn(`  failed to update ${row.source_id}/${row.external_id}: ${updateErr.message}`);
      continue;
    }
    updated++;
  }

  console.log(`Done. ${updated} listing(s) updated with real coordinates, ${skipped} skipped (postcode not recognised by postcodes.io).`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
