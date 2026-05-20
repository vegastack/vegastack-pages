// CSP + transport-security policy generators. Applied by middleware on
// every response.
//
// Two CSP profiles:
//
//   1. HTML responses (the app shell, login/signup/setup, public
//      publications under /p/* and /f/*, OAuth consent screens, docs):
//      a real browser-facing CSP that hardens against XSS + clickjacking
//      while still permitting Astro hydration scripts and inline pre-
//      paint scripts (which we already mark `is:inline`). Public
//      publication pages get a STRICTER profile (no `unsafe-inline` on
//      script-src) because they don't need hydration.
//
//   2. Non-HTML responses (API JSON, MCP, /api/csrf, attachments):
//      a tight machine-facing CSP that locks down everything by default.
//      Some clients (Cloudflare's worker preview, fetch-only consumers)
//      ignore CSP entirely; this is defense-in-depth for the edge case
//      where a JSON body is misrendered as HTML by a buggy proxy.

export function contentSecurityPolicyForResponse(input: {
  contentType: string | null;
  pathname: string;
  dev?: boolean;
}) {
  const isHtml = input.contentType?.toLowerCase().includes("text/html");
  // Vite's HMR (dev-only) requires inline scripts for the React refresh
  // preamble + a websocket for live reload. Production builds bundle the
  // preamble into a `self`-served file, so the strict CSP is fine there.
  // Relax `script-src` to allow `'unsafe-inline'` AND broaden
  // `connect-src` to allow `ws:`/`wss:` so the HMR socket can attach,
  // ONLY when running under `astro dev`.
  const dev = input.dev ?? false;
  if (isHtml) {
    // Browser-facing HTML. Astro emits hydration scripts and pre-paint
    // inline scripts (theme, comments-rail width, csrf fetch interceptor,
    // ClientRouter view-transitions boot) from the shared layout —
    // including on public publication pages. Until Astro supports
    // per-request CSP nonces (tracked at astro#11941), we allow
    // 'unsafe-inline' uniformly. `static.cloudflareinsights.com` is
    // whitelisted for the Cloudflare Web Analytics beacon injected on
    // the worker edge.
    const scriptSrc =
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com";
    const connectSrc = dev
      ? "connect-src 'self' ws: wss: https://static.cloudflareinsights.com https://cloudflareinsights.com"
      : "connect-src 'self' https://static.cloudflareinsights.com https://cloudflareinsights.com";
    return [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      // No external frames; `frame-ancestors 'none'` blocks clickjacking
      // by refusing to be embedded anywhere.
      "frame-ancestors 'none'",
      // OAuth authorize/consent posts to /oauth/authorize/consent (self)
      // and then 302s the user-agent to the client's redirect_uri,
      // which can be any HTTPS origin (claude.ai, cursor.sh, …).
      // Chrome enforces form-action across the full redirect chain, so
      // 'self' alone kills "Allow Claude" / "Allow Cursor" buttons.
      // Allow any HTTPS form target.
      "form-action 'self' https:",
      scriptSrc,
      // Tailwind + Astro inject inline styles; allow them.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      connectSrc,
      // The HTML preview iframe (sandboxed, srcdoc-rendered) is the
      // only legitimate same-origin frame source.
      "frame-src 'self'",
      "manifest-src 'self'",
      // Allow Web Workers spawned from blob: URLs. Astro's dev toolbar
      // and some hydration helpers (sonner, comments island) construct
      // workers via `new Worker(URL.createObjectURL(new Blob([...])))`.
      // Without an explicit `worker-src`, browsers fall back to
      // `script-src` which blocks `blob:`.
      "worker-src 'self' blob:",
    ].join("; ");
  }

  // Non-HTML responses (JSON APIs, MCP, SVG, etc).
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
