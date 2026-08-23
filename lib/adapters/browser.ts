/**
 * Shared serverless-compatible Chromium launcher — every Playwright-based
 * adapter (autoAdapter.ts, ballymore.ts, berkeley.ts, fairviewNewHomes.ts,
 * lqHomes.ts, peabodyNewHomes.ts) calls getSharedBrowser() here instead of
 * each launching and keeping alive its own separate browser process. Same
 * adapters, same extraction logic, same "no fake data" rules throughout —
 * this file only changes how (and where) the underlying Chromium process
 * gets started.
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
 *
 * A single browser instance is shared across every adapter that calls
 * this — multiple independent contexts/pages on one browser is exactly
 * what Playwright is designed for, and running one Chromium process
 * instead of six (one per adapter file, as this app used to do) matters a
 * lot more on a memory-capped serverless function than it did on a dev
 * machine.
 */
import type { Browser } from "playwright-core";

declare global {
  // eslint-disable-next-line no-var
  var __sharedBrowser: Promise<Browser> | undefined;
}

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

/** Returns a single, shared, lazily-launched Chromium instance. Every
 * Playwright-based adapter should call this instead of launching its own
 * browser — see file header. */
export function getSharedBrowser(): Promise<Browser> {
  if (!globalThis.__sharedBrowser) {
    globalThis.__sharedBrowser = launchBrowser();
  }
  return globalThis.__sharedBrowser;
}

/**
 * Closes the shared Chromium instance and clears the cached promise, if one
 * was ever launched — a no-op otherwise. An open Playwright `Browser` keeps
 * a live connection to its browser subprocess, which keeps Node's event
 * loop alive indefinitely; a short-lived process that's genuinely done
 * needs this called before it can exit on its own (see
 * scripts/run-sync.ts, which also force-exits afterwards as a backstop).
 *
 * Deliberately never called from any Vercel-facing route or from
 * lib/syncEngine.ts itself — keeping the browser warm across invocations
 * within the same warm serverless instance is the whole point of the
 * shared singleton there (see this file's own header); closing it after
 * every sync would defeat that.
 */
export async function closeSharedBrowser(): Promise<void> {
  const pending = globalThis.__sharedBrowser;
  if (!pending) return;
  globalThis.__sharedBrowser = undefined;
  try {
    const browser = await pending;
    await browser.close();
  } catch (err) {
    // Best-effort — the caller is about to force-exit the process anyway
    // (see scripts/run-sync.ts), so a browser that's already gone or
    // refuses to close cleanly isn't worth failing the run over.
    console.warn(
      `[browser] closeSharedBrowser: failed to close cleanly (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
