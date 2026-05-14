export function issuerForRequest(request: Request): string {
  const headers = request.headers;
  const forwardedProto = headers.get("x-forwarded-proto");
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost) {
    const proto = (forwardedProto ?? "https").split(",")[0]!.trim();
    const host = forwardedHost.split(",")[0]!.trim();
    return `${proto}://${host}`;
  }
  const url = new URL(request.url);
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
