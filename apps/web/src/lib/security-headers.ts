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

const PUBLIC_PUBLICATION_PREFIXES = ["/p/", "/f/"];

function isPublicPublicationPath(pathname: string) {
  return PUBLIC_PUBLICATION_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

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
    // Browser-facing HTML.
    const strict = isPublicPublicationPath(input.pathname);
    // Astro emits hydration scripts and small pre-paint inline scripts
    // (theme, comments-rail width, csrf fetch interceptor) in
    // AppLayout.astro. Until we attach a per-request nonce to every
    // emitted <script>, we must allow 'unsafe-inline' on script-src
    // for routes that hydrate. Public publications stay strict in
    // production; in dev they relax for Vite's HMR preamble.
    // SEC-04 (deferred): Astro 6 SSR doesn't support per-request CSP
    // nonces — its experimental CSP support generates build-time
    // hashes only. A partial migration where our own `<script
    // is:inline>` blocks carry nonces but Astro's auto-emitted
    // hydration scripts don't would force `'unsafe-inline'` back in
    // anyway, defeating the benefit. Revisit once Astro supports
    // runtime nonces (tracked at astro#11941). Until then, app-shell
    // HTML pays the `'unsafe-inline'` cost and public publication
    // HTML stays strict (it doesn't hydrate).
    const scriptSrc =
      strict && !dev
        ? "script-src 'self'"
        : "script-src 'self' 'unsafe-inline'";
    const connectSrc = dev
      ? "connect-src 'self' ws: wss:"
      : "connect-src 'self'";
    return [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      // No external frames; `frame-ancestors 'none'` blocks clickjacking
      // by refusing to be embedded anywhere.
      "frame-ancestors 'none'",
      "form-action 'self'",
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
      // `script-src` which blocks `blob:`. Production app paths need
      // this too — public publications stay tight (no inline workers).
      strict && !dev ? "worker-src 'self'" : "worker-src 'self' blob:",
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
