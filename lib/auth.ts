/**
 * Server-side session auth for the one operator account ("reza"). No
 * database/session table — a signed, http-only cookie is enough for a
 * single-user login, and it's what every protected route actually checks
 * (never just a front-end button being hidden).
 *
 * The password itself is never hardcoded — it's read from the
 * `AUTH_PASSWORD` env var (set in .env.local locally, and in Vercel's
 * project settings for production) every time it's needed, not cached at
 * module load, so a password rotation takes effect on the very next login
 * attempt without a redeploy.
 *
 * Session tokens are signed with HMAC-SHA256 keyed by that same
 * `AUTH_PASSWORD` — deliberately, so no *separate* secret needs to be
 * provisioned just for this, and so rotating the password automatically
 * invalidates every existing session (a feature: changing the password logs
 * everyone out). A token is `base64url(payload json).base64url(signature)`;
 * `verifySessionToken` re-computes the signature and compares it with
 * `crypto.timingSafeEqual` (via a fixed-length HMAC digest of each side, so
 * unequal-length inputs never throw and never leak timing information),
 * then checks the embedded expiry.
 *
 * To protect a new route later (e.g. the planned refresh-history endpoint),
 * call `isAuthenticated()` from inside the route handler and return 401 if
 * it's false — see app/api/sync/route.ts for the pattern.
 */
import crypto from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "hf_session";
export const AUTH_USERNAME = "reza";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  u: string;
  exp: number; // epoch ms
}

function getAuthPassword(): string | null {
  const pw = process.env.AUTH_PASSWORD;
  return pw && pw.length > 0 ? pw : null;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return base64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
}

/** Constant-time string comparison, safe for unequal-length inputs — hashes
 * each side to a fixed-length digest first so crypto.timingSafeEqual (which
 * throws on mismatched buffer lengths) always gets equal-length buffers,
 * and so the comparison itself never leaks either string's real length via
 * timing. */
function safeStringsEqual(a: string, b: string): boolean {
  const key = crypto.randomBytes(32);
  const ah = crypto.createHmac("sha256", key).update(a).digest();
  const bh = crypto.createHmac("sha256", key).update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** Verifies `username`/`password` against the fixed account. Returns false
 * (never throws) if AUTH_PASSWORD isn't configured — an unset password must
 * never be treated as "any password works". */
export function verifyCredentials(username: string, password: string): boolean {
  const authPassword = getAuthPassword();
  if (!authPassword) return false;
  return username === AUTH_USERNAME && safeStringsEqual(password, authPassword);
}

/** Creates a new signed session token for the fixed account. Throws if
 * AUTH_PASSWORD isn't configured — callers should only reach this after
 * verifyCredentials() has already succeeded, which guarantees that. */
export function createSessionToken(): string {
  const authPassword = getAuthPassword();
  if (!authPassword) {
    throw new Error("AUTH_PASSWORD is not set — cannot create a session.");
  }
  const payload: SessionPayload = {
    u: AUTH_USERNAME,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), "utf-8"));
  const signature = sign(payloadB64, authPassword);
  return `${payloadB64}.${signature}`;
}

/** Verifies a session token's signature and expiry. False on anything that
 * doesn't check out (missing token, bad signature, expired, malformed,
 * AUTH_PASSWORD unset/rotated since the token was issued) — never throws,
 * so every caller can treat it as a plain boolean gate. */
export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const authPassword = getAuthPassword();
  if (!authPassword) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;

  const expectedSignature = sign(payloadB64, authPassword);
  if (!safeStringsEqual(signature, expectedSignature)) return false;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  } catch {
    return false;
  }
  if (payload.u !== AUTH_USERNAME) return false;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return false;

  return true;
}

/** The real, server-side auth gate — reads the http-only session cookie
 * straight from the incoming request via next/headers, so it works
 * identically in any Route Handler regardless of how the request got
 * there. This is what actually protects an endpoint; a front-end hiding a
 * button is never sufficient on its own. */
export function isAuthenticated(): boolean {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}
