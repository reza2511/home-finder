// Distinctive multi-word phrasing that essentially only appears on an actual
// challenge/interstitial page — matched regardless of body size.
const STRONG_BLOCK_PATTERNS: RegExp[] = [
  /checking your browser before accessing/i,
  /just a moment\.\.\./i,
  /cf-browser-verification/i,
  /cf-chl-bypass/i,
  /attention required! \| cloudflare/i,
  /please stand by, while we are checking your browser/i,
  /you have been blocked/i,
  /request unsuccessful\. incapsula/i,
  /px-captcha/i,
  /this website is using a security service to protect itself/i,
];

// Generic single-word signals that also show up legitimately on real pages
// (e.g. a contact form's own reCAPTCHA widget, or a "we use Cloudflare"
// mention) — only trusted as a block signal on a short response, where an
// actual challenge page is basically the entire body.
const WEAK_BLOCK_PATTERNS: RegExp[] = [
  /cloudflare/i,
  /akamai/i,
  /access denied/i,
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /are you a human/i,
  /perimeterx/i,
  /bot detection/i,
];
const WEAK_SIGNAL_MAX_BODY_LENGTH = 20_000;

const BLOCK_HTTP_STATUSES = new Set([403, 429]);

/**
 * True if the given HTTP status and/or response body indicates the source
 * bot-blocked the request (rather than a generic network/parse failure).
 */
export function isBotBlockSignal(
  httpStatus?: number | null,
  body?: string | null
): boolean {
  if (httpStatus != null && BLOCK_HTTP_STATUSES.has(httpStatus)) {
    return true;
  }
  if (!body) return false;
  if (STRONG_BLOCK_PATTERNS.some((pattern) => pattern.test(body))) return true;
  if (body.length > WEAK_SIGNAL_MAX_BODY_LENGTH) return false;
  return WEAK_BLOCK_PATTERNS.some((pattern) => pattern.test(body));
}
