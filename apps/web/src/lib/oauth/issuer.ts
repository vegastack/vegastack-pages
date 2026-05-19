// Compute the canonical OAuth issuer URL for a request.
//
// We accept `X-Forwarded-Host` / `X-Forwarded-Proto` from a proxy only
// when the forwarded host appears on an explicit allowlist:
//
//   1. The hostname of `VPG_BASE_URL` — the operator-configured public
//      origin. Always trusted.
//   2. Any hostname in `VPG_MCP_ALLOWED_HOSTS` (comma-separated) — the
//      same allowlist used by `validateHost()` for DNS-rebinding
//      protection on the MCP surface.
//
// Without this gate an attacker could probe the
// `/.well-known/oauth-authorization-server` metadata while injecting
// their own `X-Forwarded-Host`, causing the server to advertise OAuth
// endpoints under an attacker-controlled origin to whatever client
// happened to relay the request. Real proxies (Cloudflare, k8s
// ingress) sanitise these headers, but defense-in-depth here is cheap.
const TRUSTED_PROTOS = new Set(["http", "https"]);

function normalizeHost(value: string): string {
  return value.toLowerCase().trim();
}

function allowedForwardHosts(): Set<string> {
  const hosts = new Set<string>();
  const baseUrl = process.env.VPG_BASE_URL ?? "";
  if (baseUrl) {
    try {
      hosts.add(normalizeHost(new URL(baseUrl).host));
    } catch {
      // Ignore malformed VPG_BASE_URL — operator misconfiguration
      // should not enable header trust.
    }
  }
  for (const raw of (process.env.VPG_MCP_ALLOWED_HOSTS ?? "").split(",")) {
    const trimmed = raw.trim();
    if (trimmed) hosts.add(normalizeHost(trimmed));
  }
  return hosts;
}

export function issuerForRequest(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost) {
    const allowed = allowedForwardHosts();
    if (allowed.has(normalizeHost(forwardedHost))) {
      const forwardedProto =
        request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "";
      const proto = TRUSTED_PROTOS.has(forwardedProto)
        ? forwardedProto
        : url.protocol.replace(":", "");
      return `${proto}://${forwardedHost}`;
    }
  }
  return url.origin;
}

export function resourceForRequest(request: Request): string {
  return `${issuerForRequest(request)}/mcp`;
}

/**
 * Validate the Host header to protect against DNS rebinding attacks per the
 * MCP 2025-06-18 Streamable HTTP transport requirement. We accept the request
 * when its Host header matches the expected origin host (request.url-derived,
 * X-Forwarded-Host honored), with an explicit allowlist for loopback/private
 * addresses commonly used by local development and self-host deployments.
 *
 * Returns null when valid; otherwise an error string identifying the failure.
 */
export function validateHost(request: Request): string | null {
  let urlHost = "";
  try {
    urlHost = new URL(request.url).host;
  } catch {
    return "Invalid request URL.";
  }
  const hostHeader =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    request.headers.get("host") ??
    urlHost;
  if (!hostHeader) {
    return null;
  }
  const normalize = (value: string) => value.toLowerCase().trim();
  const normalized = normalize(hostHeader);
  if (normalize(urlHost) === normalized) return null;
  const allowExtra = (process.env.VPG_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowExtra.some((value) => normalize(value) === normalized)) return null;
  const host = hostHeader.split(":")[0]!.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  ) {
    return null;
  }
  return `Host header "${hostHeader}" does not match this server.`;
}
