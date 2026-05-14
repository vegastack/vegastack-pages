import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sameOrigin, validCsrfToken } from "./lib/csrf";
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

  it("leaves HTML documents without a middleware CSP and without Astro auto-CSP", () => {
    // Astro 6's `security.csp` injects a <meta> CSP whose sha256 hashes only
    // cover scripts/styles processed at build time. Our HTML pages also rely
    // on `<script is:inline>` (theme + CSRF fetch wrapper in AppLayout.astro),
    // `set:html` markdown that can carry inline styles, and runtime style
    // injection from libraries like Sonner — none of which can be hashed
    // ahead of time. Enabling Astro's auto-CSP therefore blocks the CSRF
    // header injection and trips CSRF_BLOCKED on every browser mutation.
    // Until we adopt a nonce-based HTML CSP end-to-end, both this middleware
    // and astro.config.mjs must stay out of the HTML CSP business.
    const csp = contentSecurityPolicyForResponse({
      contentType: "text/html; charset=utf-8",
      pathname: "/p/get-started-a8f31c",
    });
    const config = readFileSync(
      new URL("../astro.config.mjs", import.meta.url),
      "utf8",
    );

    expect(csp).toBeNull();
    expect(config).not.toMatch(/^\s*csp:\s*\{/m);
    expect(config).not.toContain("scriptDirective");
    expect(config).not.toContain("styleDirective");
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

  it("requires a matching CSRF token for session-cookie mutations", () => {
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
    const bearerOnly = new Request("https://pages.example.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer mcp_test" },
    });

    expect(validCsrfToken(withoutToken)).toBe(false);
    expect(validCsrfToken(withToken)).toBe(true);
    expect(validCsrfToken(bearerOnly)).toBe(true);
  });

  it("bypasses runtime persistence for static docs routes only", () => {
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
      bypassesRuntimePersistence({ method: "GET", pathname: "/app" }),
    ).toBe(false);
  });
});
