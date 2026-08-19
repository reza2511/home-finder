# Home Finder

A small Next.js app that aggregates real new-build listings from Barratt
London and includes a **Status Monitor** for keeping an eye on the source
adapter.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000. The first request to `/api/status` runs an
initial sync automatically (a real fetch against barratthomes.co.uk, so it
can take up to ~30s), so the Status Monitor and homepage won't be empty on
first load.

## How it's built

- **Next.js 14 (App Router) + TypeScript**, plain CSS (`app/globals.css`) — no
  extra UI framework, to keep styling simple and consistent.
- **Storage**: Supabase Postgres — see `lib/db.ts` and
  `supabase/migrations/*.sql`. Reads (`GET /api/listings`, `GET
  /api/status`) go through the `anon` key, subject to RLS's public-SELECT-only
  policies; writes (the sync job) go through the `service_role` key
  (`SUPABASE_SERVICE_ROLE_KEY`, server-only, never `NEXT_PUBLIC_*`), which
  bypasses RLS — `listings`/`sync_status` have no anon/authenticated
  insert/update policy at all. Credentials live in `.env.local`
  (git-ignored, never committed). Every sync also prunes any rows whose
  `source_id` isn't in the current adapter registry, so removed/renamed
  sources don't leave stale rows behind.
- **Source adapter** (`lib/adapters/barrattLondon.ts`): real data only, no
  mocks. It calls two public, unauthenticated barratthomes.co.uk endpoints
  (checked against robots.txt first):
  - `GET /api/search/devplots?brandCodes=bln` — every current Barratt London
    development (name, address, real photo, real development URL).
  - Each development's own detail page, which server-renders a real
    "available homes" list of individual plot cards (plot number, one real
    bedroom count, one real price, a real photo, a real per-home URL) — this
    is what each `Listing` maps to.

  Two fields are genuinely not published anywhere on the site and are left
  `null` rather than guessed: **tenure** (no page states it, only a generic
  "Freehold vs Leasehold" guide link) and **bedroomType** (single/double per
  room — Barratt doesn't break bedrooms down that way). The UI shows "Tenure
  not stated" for these, and the tenure/bedroom-type filters simply won't
  match them.
- **Sync engine** (`lib/syncEngine.ts`): wraps the adapter call in try/catch
  and records one row per source in the `sync_status` table: `sourceId,
  sourceName, lastRunAt, lastSuccessAt, status, httpStatus, listingsFound,
  added, updated, removed, durationMs, errorMessage`.
  - `ok` — ran, found listings.
  - `no_results` — ran cleanly but found zero listings (possible silent
    breakage, e.g. a changed selector).
  - `blocked` — HTTP 403/429, or a Cloudflare/Akamai/CAPTCHA challenge page
    detected in the body (`lib/adapters/blockDetection.ts`), even on a 200.
  - `error` — network failure, timeout, unexpected response shape, or
    anything else; the real exception message (often including a snippet of
    what was actually received) is stored and shown in the Status Monitor.
  - `stale` — not stored; derived at read time (`lib/statusDerive.ts`) when
    there's been no successful run in the last 26h (syncs run every 12h).
- **API**:
  - `GET /api/status` — every `sync_status` row (with `stale` derived) plus a
    summary count per status.
  - `POST /api/sync` — runs the adapter now.
  - `GET /api/listings` — aggregated active listings, for the homepage grid.
- **UI**: `components/Header.tsx` has the "Status Monitor" button (with a
  live health dot). `components/StatusMonitorModal.tsx` is the modal: filter
  tabs with live counts (All / Updated / Not updating / Blocked / Errors),
  a colour-coded badge per source, relative last-success time, listings
  found, error message, and a "Run sync now" button that re-syncs and
  refreshes the list. `components/FilterPanel.tsx` + `lib/filterListings.ts`
  filter the homepage grid live (bedrooms, price range, tenure, new-build,
  postcode/area search) with no network round-trip.

## Notes

- If Barratt London changes their site structure, the adapter is written to
  fail loudly rather than silently return nothing: a JSON-shape mismatch or a
  structural parse failure throws an error with a real snippet of what was
  actually received, which shows up as `error` with that message in the
  Status Monitor — never as fabricated listings.
- `npm audit` flags two `next`/`postcss` advisories that currently only have a
  fix on the Next.js 16 branch. This app stays on Next 14.2.x (latest patch)
  since it's a local dev app, not internet-facing — worth revisiting before
  any real deployment.
