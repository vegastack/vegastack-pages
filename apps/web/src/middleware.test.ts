import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasBearerAuth, sameOrigin, validCsrfToken } from "./lib/csrf";
import {
  contentSecurityPolicyForResponse,
  strictTransportSecurityForRequest,
} from "./lib/security-headers";
import { bypassesRuntimePersistence } from "./lib/middleware-policy";

describe("security headers", () => {
  it("does not allow inline or eval scripts in middleware CSP", () => {
    const csp = contentSecurityPolicyForResponse({
      contentType: "application/json",
      pathname: "/api/pages/pg_test/source",
    });

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("sets a real HTML CSP that allows inline hydration scripts but blocks framing", () => {
    // The middleware emits a per-response CSP for HTML documents that
    // permits Astro's `<script is:inline>` pre-paint scripts (theme,
    // CSRF fetch wrapper, comments-rail width) and library-injected
    // styles (Sonner, Tailwind) while still locking down framing and
    // foreign script/connect sources. Astro's build-time auto-CSP is
    // intentionally disabled — those build-time hashes cannot cover
    // runtime-injected inline content.
    const csp = contentSecurityPolicyForResponse({
      contentType: "text/html; charset=utf-8",
      pathname: "/app",
    });
    const config = readFileSync(
      new URL("../astro.config.mjs", import.meta.url),
      "utf8",
    );

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // OAuth authorize/consent POSTs need to redirect to third-party
    // redirect_uri values (claude.ai etc.). Chrome enforces form-action
    // across redirect chains, so we allow any HTTPS target.
    expect(csp).toContain("form-action 'self' https:");
    // App pages hydrate so inline scripts + styles are allowed; the
    // public publication profile below tightens this further.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(config).not.toMatch(/^\s*csp:\s*\{/m);
    expect(config).not.toContain("scriptDirective");
    expect(config).not.toContain("styleDirective");
  });

  it("uses the same permissive HTML CSP on public publication paths", () => {
    // Public published pages share AppLayout (theme detect, CSRF wrapper,
    // ClientRouter view-transitions boot) which emits inline scripts.
    // They must use the same `'unsafe-inline'` profile as the app shell —
    // otherwise inline boot scripts get killed and any subsequent
    // ClientRouter navigation carries the strict CSP into /app/* DOM
    // swaps, breaking dropdowns and modals on the swapped-in content.
    const csp = contentSecurityPolicyForResponse({
      contentType: "text/html; charset=utf-8",
      pathname: "/p/get-started-a8f31c",
    });
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("declares worker-src so app code can spawn blob: workers", () => {
    // The Astro dev toolbar and a handful of hydration helpers
    // (sonner, comments island) construct Web Workers from blob: URLs.
    // Browsers fall back to script-src when worker-src is unset, so the
    // blob load silently fails and the worker never starts. Declaring
    // worker-src explicitly fixes that AND documents what's expected.
    const appCsp = contentSecurityPolicyForResponse({
      contentType: "text/html; charset=utf-8",
      pathname: "/app",
    });
    expect(appCsp).toContain("worker-src 'self' blob:");

    const publicCsp = contentSecurityPolicyForResponse({
      contentType: "text/html; charset=utf-8",
      pathname: "/p/get-started-a8f31c",
    });
    expect(publicCsp).toContain("worker-src 'self' blob:");
  });

  it("relaxes connect-src under dev for Vite HMR sockets", () => {
    // Vite's HMR socket needs ws:/wss:. The script-src already permits
    // inline content in both prod and dev, so no extra relax needed
    // there.
    const csp = contentSecurityPolicyForResponse({
      contentType: "text/html; charset=utf-8",
      pathname: "/p/get-started-a8f31c",
      dev: true,
    });
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
  });

  it("whitelists the Cloudflare Web Analytics beacon host on script-src", () => {
    const csp = contentSecurityPolicyForResponse({
      contentType: "text/html; charset=utf-8",
      pathname: "/app",
    });
    expect(csp).toContain("https://static.cloudflareinsights.com");
  });

  it("keeps Astro's global form-origin check disabled for OAuth form posts", () => {
    // Astro's checkOrigin runs before route middleware and rejects
    // application/x-www-form-urlencoded cross-origin POSTs. OAuth token/device
    // exchanges need that content type, while browser mutation CSRF remains
    // enforced below by sameOrigin + validCsrfToken.
    const config = readFileSync(
      new URL("../astro.config.mjs", import.meta.url),
      "utf8",
    );

    expect(config).toContain("checkOrigin: false");
  });

  it("emits HSTS only for production HTTPS requests", () => {
    expect(
      strictTransportSecurityForRequest({
        protocol: "https:",
        dev: false,
      }),
    ).toBe("max-age=31536000; includeSubDomains; preload");
    expect(
      strictTransportSecurityForRequest({
        protocol: "http:",
        dev: false,
      }),
    ).toBeNull();
    expect(
      strictTransportSecurityForRequest({
        protocol: "https:",
        dev: true,
      }),
    ).toBeNull();
  });

  it("does not trust x-forwarded headers for origin checks", () => {
    const request = new Request("https://pages.example.test/api/pages", {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example.test",
      },
    });

    expect(sameOrigin(request)).toBe(false);
  });

  it("requires a matching CSRF token on every browser mutation (including anonymous)", () => {
    // The middleware now enforces CSRF regardless of session cookie
    // presence — anonymous browser POSTs (signup, magic-link request,
    // publication password verify, public comment posts) must carry
    // the token too. Bearer-authenticated MCP/OAuth requests bypass
    // this layer via the middleware's runtime-persistence bypass list,
    // so the token gate doesn't apply there. The middleware test
    // file's earlier sameOrigin + bypass coverage stands as the gate
    // for those paths.
    const withoutToken = new Request("https://pages.example.test/api/pages", {
      method: "POST",
      headers: {
        cookie: "vpg_session=ses_test; vpg_csrf=csrf_test",
      },
    });
    const withToken = new Request("https://pages.example.test/api/pages", {
      method: "POST",
      headers: {
        cookie: "vpg_session=ses_test; vpg_csrf=csrf_test",
        "x-vpg-csrf-token": "csrf_test",
      },
    });
    const anonymousWithoutToken = new Request(
      "https://pages.example.test/api/auth/signup",
      {
        method: "POST",
        headers: { cookie: "vpg_csrf=csrf_test" },
      },
    );
    const anonymousWithToken = new Request(
      "https://pages.example.test/api/auth/signup",
      {
        method: "POST",
        headers: {
          cookie: "vpg_csrf=csrf_test",
          "x-vpg-csrf-token": "csrf_test",
        },
      },
    );

    expect(validCsrfToken(withoutToken)).toBe(false);
    expect(validCsrfToken(withToken)).toBe(true);
    // Anonymous mutations no longer bypass — must carry the token.
    expect(validCsrfToken(anonymousWithoutToken)).toBe(false);
    expect(validCsrfToken(anonymousWithToken)).toBe(true);
  });

  it("does NOT exempt empty-token Bearer headers from CSRF (audit cycle 5)", () => {
    // SECURITY: A literal header `Authorization: bearer ` (scheme + space
    // + nothing) used to bypass CSRF without satisfying the downstream
    // auth resolver, leaving a same-origin attacker with a way to defeat
    // CSRF by injecting that header from a victim's session.
    const emptyToken = new Request("https://pages.example.test/api/x", {
      method: "POST",
      headers: { authorization: "Bearer " },
    });
    const emptyTokenLowercase = new Request(
      "https://pages.example.test/api/x",
      { method: "POST", headers: { authorization: "bearer  " } },
    );
    const tabSeparator = new Request("https://pages.example.test/api/x", {
      method: "POST",
      // Tab+space between scheme and token still legitimate per RFC 7235.
      headers: { authorization: "Bearer\treal_token_here" },
    });
    expect(hasBearerAuth(emptyToken)).toBe(false);
    expect(hasBearerAuth(emptyTokenLowercase)).toBe(false);
    expect(hasBearerAuth(tabSeparator)).toBe(true);
  });

  it("exempts Bearer-authenticated API requests from the CSRF gate", () => {
    // CLI + integrations carry `Authorization: Bearer …` and don't share the
    // cookie attack surface, so the middleware short-circuits CSRF for them.
    // Same precedent as gh / wrangler / aws-cli against their APIs.
    const bearerNoCsrf = new Request(
      "https://pages.example.test/api/workspaces/wks_x/pages",
      {
        method: "POST",
        headers: { authorization: "Bearer mcp__abc" },
      },
    );
    const cookieNoCsrf = new Request(
      "https://pages.example.test/api/workspaces/wks_x/pages",
      {
        method: "POST",
        headers: { cookie: "vpg_session=ses_x; vpg_csrf=csrf_x" },
      },
    );
    const bearerLowercase = new Request("https://pages.example.test/api/x", {
      method: "POST",
      headers: { authorization: "bearer mcp__abc" },
    });
    const bearerMissing = new Request("https://pages.example.test/api/x", {
      method: "POST",
    });

    expect(hasBearerAuth(bearerNoCsrf)).toBe(true);
    expect(hasBearerAuth(bearerLowercase)).toBe(true);
    expect(hasBearerAuth(cookieNoCsrf)).toBe(false);
    expect(hasBearerAuth(bearerMissing)).toBe(false);
    // The middleware combines `!hasBearerAuth && (!sameOrigin || !validCsrfToken)`
    // to decide whether to 403. Bearer auth must make the gate pass even when
    // the cookie CSRF check would otherwise fail.
    expect(validCsrfToken(bearerNoCsrf)).toBe(false);
  });

  it("bypasses runtime persistence for static docs and MCP/OAuth routes", () => {
    expect(
      bypassesRuntimePersistence({ method: "GET", pathname: "/docs" }),
    ).toBe(true);
    expect(
      bypassesRuntimePersistence({
        method: "HEAD",
        pathname: "/docs/cloudflare",
      }),
    ).toBe(true);
    expect(
      bypassesRuntimePersistence({ method: "POST", pathname: "/docs" }),
    ).toBe(false);
    expect(
      bypassesRuntimePersistence({ method: "GET", pathname: "/mcp" }),
    ).toBe(true);
    expect(
      bypassesRuntimePersistence({ method: "POST", pathname: "/mcp" }),
    ).toBe(true);
    expect(
      bypassesRuntimePersistence({
        method: "POST",
        pathname: "/oauth/token",
      }),
    ).toBe(true);
    expect(
      bypassesRuntimePersistence({ method: "GET", pathname: "/app" }),
    ).toBe(false);
  });
});
