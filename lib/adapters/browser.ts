/**
 * Serverless-compatible Chromium launcher — every Playwright-based adapter
 * (autoAdapter.ts, ballymore.ts, berkeley.ts, fairviewNewHomes.ts,
 * lqHomes.ts, peabodyNewHomes.ts) calls withBrowser() here to get one. Same
 * adapters, same extraction logic, same "no fake data" rules throughout —
 * this file only changes how (and where) the underlying Chromium process
 * gets started and torn down.
 *
 * One browser instance per call, never shared, always closed (2026-08-24):
 * this used to hand out a single, lazily-launched Chromium instance shared
 * across every adapter AND across every invocation of the whole sync
 * (deliberately never closed, to stay warm on Vercel) via a `globalThis`-
 * cached promise. That meant every source, in every concurrently-running
 * sync, was making calls against the exact same underlying browser
 * process. Two overlapping syncs (a GitHub Actions run and a manual
 * "Run sync now" click) raced on it and crashed each other mid-run —
 * several sources failed within moments of each other with "browser.
 * newContext: Target page, context or browser has been closed", and Redrow
 * lost its listings entirely as fallout, once its own upsert ran against
 * an adapter result that had been corrupted by the crash.
 *
 * lib/syncLock.ts now makes that specific collision impossible (only one
 * sync ever runs at all), but a shared, unkillable, never-closed browser
 * was always the wrong shape regardless — one source's browser crashing
 * (or a slow one still using it) should never be able to take down every
 * other source's scrape, in the same run or a different one. withBrowser()
 * below launches a fresh Chromium instance for exactly one call and closes
 * it in a `finally` before returning — full isolation, no shared mutable
 * state, and nothing left running for a later call to collide with. The
 * cost is real (N sources launching Chromium sequentially is slower than
 * one warm shared instance), but correctness comes first here; see
 * lib/syncEngine.ts's runAllAdapters() for why every source — direct-
 * developer or second-phase — now also runs strictly one at a time rather
 * than several in parallel sharing render capacity.
 *
 * Two real environments this has to work in:
 *
 *  - Locally (`npm run dev` / `next build` on a dev machine): `playwright`
 *    is a devDependency purely so its postinstall step downloads a real
 *    Chromium build into the shared Playwright browser cache (e.g.
 *    %USERPROFILE%\AppData\Local\ms-playwright on Windows,
 *    ~/.cache/ms-playwright on Linux/macOS). `playwright-core` (no bundled
 *    browser of its own) resolves that same cached binary automatically
 *    when `chromium.launch()` is called with no `executablePath` — both
 *    packages share identical browser-revision resolution logic when their
 *    versions match (kept in lockstep in package.json). Confirmed live:
 *    `chromium.launch({ headless: true })` via a bare `playwright-core`
 *    import launches successfully with no extra config.
 *
 *  - On Vercel (`process.env.VERCEL` is set by the platform in every
 *    deployment, including `vercel dev`): there's no system Chromium and
 *    no sandbox libraries in a serverless function's filesystem, and
 *    Playwright's own ~300MB bundled-browser download isn't a fit for that
 *    environment even if present. @sparticuz/chromium ships a Chromium
 *    build compiled specifically for AWS Lambda's Node.js runtime — the
 *    same underlying execution environment Vercel's Node.js functions run
 *    on — as a brotli-compressed binary it inflates to /tmp on cold start,
 *    together with the launch args that environment actually needs
 *    (no-sandbox, single-process, etc.). This is the officially documented
 *    Playwright usage pattern from @sparticuz/chromium's own README.
 */
import type { Browser } from "playwright-core";

const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");

  if (process.env.VERCEL) {
    const chromiumBinary = (await import("@sparticuz/chromium")).default;
    return chromium.launch({
      executablePath: await chromiumBinary.executablePath(),
      args: [...chromiumBinary.args, ...LAUNCH_ARGS],
      headless: true,
    });
  }

  // Local dev / any non-Vercel environment: no executablePath given — see
  // file header for why this reliably resolves to the locally-cached
  // Chromium `playwright` (the devDependency) already downloaded.
  return chromium.launch({ headless: true, args: LAUNCH_ARGS });
}

/**
 * Launches a fresh, dedicated Chromium instance, hands it to `fn`, and
 * guarantees it's closed — success, thrown error, or timeout — before
 * returning or rethrowing. Every Playwright-based adapter should call this
 * instead of launching its own browser ad hoc, so "one browser per call,
 * always closed" stays true everywhere rather than being each adapter's
 * own responsibility to remember. See file header for why this replaced
 * the old shared/never-closed singleton.
 */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    try {
      await browser.close();
    } catch (err) {
      // Best-effort — a browser that's already gone or refuses to close
      // cleanly isn't worth failing an otherwise-successful adapter run
      // over.
      console.warn(
        `[browser] withBrowser: failed to close cleanly (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
