import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ALLOWED_DEVELOPER_IDS } from "./developers";

// This app's data layer is Supabase Postgres (supabase/migrations/*.sql) —
// not a local file. Every table it reads/writes (listings, sync_status,
// favourites) lives there; there is no local fallback, so these three
// variables are required, not optional.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set in .env.local — " +
      "this app reads and writes listings/sync_status/favourites in Supabase Postgres, not a local database."
  );
}

// Next.js's App Router patches the global `fetch` with its own persistent,
// on-disk Data Cache (.next/cache/fetch-cache) — confirmed live: a query
// made while `listings` was still genuinely empty got cached, and every
// route handler using the plain global fetch kept replaying that same
// stale empty result even after real rows existed and even across dev-
// server restarts, despite every route here already setting `export const
// dynamic = "force-dynamic"`. supabase-js accepts a custom `fetch` via the
// `global.fetch` option specifically to override this — every request both
// clients make is forced to `cache: "no-store"` so Supabase (which already
// is the live source of truth, not something Next needs to cache on top
// of) is never served stale from disk again.
function noStoreFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, cache: "no-store" });
}

/**
 * Public/read client — authenticates as Supabase's `anon` role, so every
 * query it makes is subject to the RLS policies in
 * supabase/migrations/0001_init.sql: public SELECT only, on `listings` and
 * `sync_status`. Used by every read-only API route (GET /api/listings,
 * GET /api/status).
 */
export const supabase: SupabaseClient = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false },
  global: { fetch: noStoreFetch },
});

/**
 * Privileged/write client — authenticates as Supabase's `service_role`,
 * which bypasses RLS entirely. `listings`/`sync_status` deliberately have no
 * anon/authenticated insert or update policy (see the migration's own
 * comment), so this is the only client that can ever write to them — used
 * exclusively by the sync job (lib/syncEngine.ts, lib/listingsStore.ts).
 *
 * Deliberately `null` rather than throwing at import time when the key
 * isn't set — read-only routes don't need it and should keep working;
 * anything that actually writes calls requireSupabaseAdmin() instead, which
 * throws a real, honest error rather than either silently no-op'ing or
 * writing through the anon client and failing with an opaque RLS-denied
 * error. SUPABASE_SERVICE_ROLE_KEY must never be exposed to client code or
 * committed — it isn't `NEXT_PUBLIC_*`, and .env.local is gitignored.
 */
export const supabaseAdmin: SupabaseClient | null = serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
      global: { fetch: noStoreFetch },
    })
  : null;

export function requireSupabaseAdmin(): SupabaseClient {
  if (!supabaseAdmin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set in .env.local — writing to Supabase (listings/sync_status) needs " +
        "the service_role key, since RLS has no anon/authenticated insert or update policy on those tables " +
        "(see supabase/migrations/0001_init.sql)."
    );
  }
  return supabaseAdmin;
}

/**
 * Deletes any sync_status/listings rows belonging to a sourceId that isn't
 * in london-developers.json — the canonical allow-list, checked directly
 * rather than via the adapter registry, so the database itself refuses to
 * retain rows for anything unapproved. Cleans up rows left behind by
 * adapters that were removed (e.g. the old mock sources).
 *
 * Used to run once per local SQLite connection open; there's no equivalent
 * single moment against a remote Postgres database, so it's called
 * explicitly at the start of every sync instead (see runAllAdapters in
 * lib/syncEngine.ts) — same effect, just triggered by the job that's
 * actually about to write, rather than by opening a connection.
 */
export async function pruneUnknownSources(): Promise<void> {
  const validIds = [...ALLOWED_DEVELOPER_IDS];
  if (validIds.length === 0) return;
  const admin = requireSupabaseAdmin();
  const idList = `(${validIds.join(",")})`;

  const [{ error: syncErr }, { error: listErr }] = await Promise.all([
    admin.from("sync_status").delete().not("source_id", "in", idList),
    admin.from("listings").delete().not("source_id", "in", idList),
  ]);
  if (syncErr) throw new Error(`pruneUnknownSources: failed to prune sync_status: ${syncErr.message}`);
  if (listErr) throw new Error(`pruneUnknownSources: failed to prune listings: ${listErr.message}`);
}
