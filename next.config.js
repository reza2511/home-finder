/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // playwright-core and @sparticuz/chromium both resolve files (the
    // Chromium binary, in @sparticuz/chromium's case) via relative
    // filesystem paths at runtime — bundling them into the route's webpack
    // chunk breaks that resolution (see @sparticuz/chromium's own README,
    // "Bundler Configuration": it must be marked external). This keeps
    // them as real `require()`s Node resolves from node_modules instead.
    serverComponentsExternalPackages: ["playwright-core", "@sparticuz/chromium"],
    // Vercel's build-time file tracing decides which node_modules files
    // actually ship with each serverless function. @sparticuz/chromium's
    // brotli-compressed Chromium binary (node_modules/@sparticuz/chromium/
    // bin/*.br) is loaded via a constructed path at runtime, not a static
    // `require(...)`/`import` Next can see — without this, it can be left
    // out of the deployed function, which is what the "The input directory
    // '/var/task/bin' does not exist" error means if it shows up in
    // Vercel's function logs.
    // All three routes can end up launching a browser: /api/sync always
    // does, /api/status's first-ever hit auto-triggers a full sync too (see
    // ensureInitialSyncHasRun in app/api/status/route.ts), and /api/compare
    // renders arbitrary property-listing pages (lib/compareExtract.ts).
    outputFileTracingIncludes: {
      "/api/sync": ["./node_modules/@sparticuz/chromium/bin/**"],
      "/api/status": ["./node_modules/@sparticuz/chromium/bin/**"],
      "/api/compare": ["./node_modules/@sparticuz/chromium/bin/**"],
    },
  },
};

module.exports = nextConfig;
