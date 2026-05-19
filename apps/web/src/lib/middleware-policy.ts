const runtimeBypassPrefixes = ["/docs"];

// OAuth + MCP discovery surface. These endpoints are bypassed from the
// middleware's mutation-locking layer (legacy snapshot persistence) so
// short-lived broker calls — claude.ai's DCR completes in ~1.5s — never
// queue behind the global persist sweep. Most now write through D1
// directly via the services layer, but the bypass list still applies
// to keep the middleware overhead off these latency-sensitive paths.
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
