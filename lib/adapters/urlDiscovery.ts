/**
 * URL discovery for developers whose `listings_url` is currently in `error`
 * status (see createAutoAdapter in autoAdapter.ts). Most of these point at a
 * developer's homepage rather than their actual developments/projects page —
 * this looks for a better candidate by:
 *
 *   1. Scanning the homepage's own links for anchor text/hrefs that look
 *      like a developments/projects/search-results page.
 *   2. Scanning /sitemap.xml (if the site has one) for the same.
 *
 * Every candidate returned is a real href actually found on a real page —
 * never a guessed/constructed URL. Off-site links (a different domain
 * entirely) are excluded; the app's sources are developers' own sites only.
 */
import * as cheerio from "cheerio";
import type { DeveloperEntry } from "../developers";

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// "find-a-home" is given a small amount of slack (find-your-home, find-my-home)
// since that's the same real page under a slightly different phrasing —
// e.g. Mount Anvil's actual listings page is "/find-your-home/".
const KEYWORD_RE = /development|project|our-homes|new-homes|properties|find-(?:a|your|my)-home|search/i;

// Matches the keyword regex but is never a listings page — skipped so a
// discovery pass doesn't burn an extraction attempt on a known dead end.
const EXCLUDE_RE =
  /privacy|cookie-policy|\bterms\b|careers|contact-us|about-us|\bblog\b|\bnews\b|\bpress\b|modern-slavery|accessibility/i;

const MAX_CANDIDATES = 3;

export interface DiscoveryResult {
  /** Ordered, deduped, most-promising first. Capped at MAX_CANDIDATES. */
  candidates: string[];
  /** Real reasons for partial/total failure (fetch errors, empty sitemap,
   * nothing matched) — for logging, not thrown. */
  notes: string[];
}

async function fetchText(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml,*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

function sameSite(candidateUrl: string, siteHost: string): boolean {
  try {
    const host = new URL(candidateUrl).hostname.replace(/^www\./, "");
    return host === siteHost || host.endsWith(`.${siteHost}`);
  } catch {
    return false;
  }
}

// Prefers matches in the URL path itself (deliberate navigation, not sitemap
// noise) and prefers the more specific keywords over the generic "search"/
// "properties", which are more likely to false-positive on unrelated pages.
function scoreCandidate(url: string, text: string): number {
  let score = 0;
  if (/development|project|our-homes|new-homes|find-(?:a|your|my)-home/i.test(url)) score += 2;
  if (/development|project|our-homes|new-homes|find-(?:a|your|my)-home/i.test(text)) score += 2;
  if (/properties/i.test(url) || /properties/i.test(text)) score += 1;
  if (/\bsearch\b/i.test(url) || /\bsearch\b/i.test(text)) score += 1;
  return score;
}

export async function discoverCandidateUrls(developer: DeveloperEntry): Promise<DiscoveryResult> {
  const notes: string[] = [];
  let siteHost: string;
  try {
    siteHost = new URL(developer.website).hostname.replace(/^www\./, "");
  } catch {
    return { candidates: [], notes: [`developer.website "${developer.website}" is not a valid URL`] };
  }

  const scored = new Map<string, number>(); // absolute url -> best score seen

  function consider(rawUrl: string, linkText: string, base: string) {
    let abs: string;
    try {
      abs = new URL(rawUrl, base).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(abs)) return; // skip mailto:, tel:, javascript:, etc.
    if (!sameSite(abs, siteHost)) return; // developers' own sites only
    if (!(KEYWORD_RE.test(rawUrl) || KEYWORD_RE.test(linkText))) return;
    if (EXCLUDE_RE.test(rawUrl) || EXCLUDE_RE.test(linkText)) return;

    const clean = abs.split("#")[0];
    const score = scoreCandidate(clean, linkText);
    if (!scored.has(clean) || scored.get(clean)! < score) scored.set(clean, score);
  }

  // 1) Homepage nav/body links
  const home = await fetchText(developer.website);
  if (!home) {
    notes.push(`homepage fetch failed: ${developer.website}`);
  } else if (home.status < 200 || home.status >= 300) {
    notes.push(`homepage returned HTTP ${home.status}: ${developer.website}`);
  } else {
    const $ = cheerio.load(home.text);
    $("a[href]").each((_, el) => {
      consider($(el).attr("href") ?? "", $(el).text().trim(), developer.website);
    });
  }

  // 2) sitemap.xml
  let sitemapUrl = "";
  try {
    sitemapUrl = new URL("/sitemap.xml", developer.website).toString();
  } catch {
    /* invalid base — already noted above via siteHost */
  }
  if (sitemapUrl) {
    const sitemap = await fetchText(sitemapUrl);
    if (!sitemap) {
      notes.push(`sitemap fetch failed: ${sitemapUrl}`);
    } else if (sitemap.status < 200 || sitemap.status >= 300) {
      notes.push(`sitemap returned HTTP ${sitemap.status}: ${sitemapUrl}`);
    } else {
      const locRe = /<loc>([^<]+)<\/loc>/gi;
      let match: RegExpExecArray | null;
      let locCount = 0;
      while ((match = locRe.exec(sitemap.text))) {
        locCount++;
        consider(match[1].trim(), "", sitemapUrl);
      }
      if (locCount === 0) notes.push(`sitemap had no <loc> entries: ${sitemapUrl}`);
    }
  }

  const candidates = Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) {
    notes.push(
      "no development/project/our-homes/new-homes/properties/find-a-home/search link found on the " +
        "homepage or sitemap.xml"
    );
  }

  return { candidates, notes };
}
