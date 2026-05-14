const runtimeBypassPrefixes = ["/docs"];

// OAuth + MCP discovery surface. These endpoints must not be wrapped in the
// runtime-mutation lock + persistRuntimeState() pair the middleware applies
// to other POSTs: claude.ai's connector broker cancels DCR after ~1.5s, and
// our per-POST persistence loop alone consumes most of that window even when
// the handler itself is fast. Each of these endpoints either touches no
// runtime state (the well-known docs, /register fast path, /revoke, HEAD on
// /mcp) or does its own narrow D1 writes (the generic /register slow path,
// /token, /authorize/consent, /authorize/resume) and doesn't need the
// global persist sweep.
const oauthBypassExactPaths = new Set([
  "/mcp",
  "/register",
  "/token",
  "/revoke",
  "/device",
  "/authorize",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/device",
  "/oauth/device/verify",
  "/oauth/authorize",
  "/oauth/authorize/consent",
  "/oauth/authorize/resume",
]);

const wellKnownPrefix = "/.well-known/oauth-";

export function bypassesRuntimePersistence(input: {
  method: string;
  pathname: string;
}) {
  const method = input.method.toUpperCase();
  // OAuth + MCP discovery: bypass for every method (browser GETs on the
  // /authorize page, POSTs on /register and /token, etc.) so the middleware
  // never holds the mutation lock or runs the persist sweep on this surface.
  if (
    oauthBypassExactPaths.has(input.pathname) ||
    input.pathname.startsWith(wellKnownPrefix)
  ) {
    return true;
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return false;
  }
  return runtimeBypassPrefixes.some(
    (prefix) =>
      input.pathname === prefix || input.pathname.startsWith(`${prefix}/`),
  );
}
