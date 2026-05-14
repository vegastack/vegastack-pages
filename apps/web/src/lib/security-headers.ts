export function contentSecurityPolicyForResponse(input: {
  contentType: string | null;
  pathname: string;
}) {
  if (input.contentType?.toLowerCase().includes("text/html")) {
    return null;
  }
  const isApiSurface =
    input.pathname.startsWith("/api/") || input.pathname === "/mcp";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    isApiSurface ? "frame-ancestors 'none'" : "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
  ].join("; ");
}

export function strictTransportSecurityForRequest(input: {
  protocol: string;
  dev: boolean;
}) {
  if (input.dev || input.protocol !== "https:") return null;
  return "max-age=31536000; includeSubDomains; preload";
}
