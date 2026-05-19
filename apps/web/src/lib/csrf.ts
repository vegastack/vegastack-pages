export const csrfCookieName = "vpg_csrf";
export const csrfHeaderName = "x-vpg-csrf-token";

export function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return "";
}

export function randomCsrfToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function csrfCookie(value: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${csrfCookieName}=${value}; Path=/; SameSite=Lax${secure}`;
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export function sameOrigin(request: Request) {
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== expectedOrigin) return false;
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") return false;
  return true;
}

// CSRF check applied to every browser-class mutation (POST/PUT/PATCH/DELETE)
// inside the middleware. The token cookie is set unconditionally on the
// first response of every session — anonymous mutations (signup,
// magic-link request, dev-login, publication password verify, public
// comment posts) all carry it once AppLayout's fetch interceptor
// (apps/web/src/layouts/AppLayout.astro) attaches the matching header.
// Previously this returned `true` for cookie-less requests, which let
// any cross-site form-POST through; same-origin alone was the gate.
// Now the token is required regardless of session state, so a missing
// or mismatched token always fails closed.
export function validCsrfToken(request: Request) {
  const cookieToken = readCookie(request, csrfCookieName);
  const headerToken = request.headers.get(csrfHeaderName) ?? "";
  return Boolean(
    cookieToken && headerToken && constantTimeEqual(cookieToken, headerToken),
  );
}

// Bearer-token API clients (CLI, agent SDKs, integrations) authenticate
// via Authorization header, not cookies, so they don't share the cookie
// attack surface CSRF is built to defend. Skip the CSRF gate when a
// Bearer token is present — same model as gh / wrangler / aws-cli.
//
// SECURITY: must require a *non-empty* token. A literal header like
// `Authorization: bearer ` (scheme + space + no token) would otherwise
// bypass CSRF without satisfying the downstream auth resolver, leaving
// a same-origin attacker with a way to defeat CSRF by injecting that
// header from a victim's session (audit cycle 5 finding).
export function hasBearerAuth(request: Request) {
  return parseBearerToken(request) !== null;
}

/**
 * Parse `Authorization: Bearer <token>` and return the token if present
 * and non-empty. Returns null for absent header, non-Bearer scheme, or
 * empty token after the scheme. Case-insensitive on the scheme name per
 * RFC 7235; the token itself is not trimmed beyond ASCII whitespace.
 */
export function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  // Match `Bearer ` / `bearer ` etc.; capture the token, allow trailing whitespace.
  const match = /^bearer\s+(\S.*)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}
