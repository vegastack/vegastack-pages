import { defineMiddleware } from "astro:middleware";
import { ensureRuntimeReady } from "./lib/runtime";
import {
  csrfCookie,
  csrfCookieName,
  hasBearerAuth,
  randomCsrfToken,
  readCookie,
  sameOrigin,
  validCsrfToken,
} from "./lib/csrf";
import {
  contentSecurityPolicyForResponse,
  strictTransportSecurityForRequest,
} from "./lib/security-headers";
import { bypassesRuntimePersistence } from "./lib/middleware-policy";

const browserMutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const defaultSlowRequestMs = 1_000;

function slowRequestThresholdMs(): number {
  const configured = Number(process.env.VPG_SLOW_REQUEST_LOG_MS ?? "");
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : defaultSlowRequestMs;
}

function withServerTiming(response: Response, durationMs: number): Response {
  const headers = new Headers(response.headers);
  const prior = headers.get("server-timing");
  const timing = `vpg;dur=${durationMs.toFixed(1)}`;
  headers.set("server-timing", prior ? `${prior}, ${timing}` : timing);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logSlowRequest(input: {
  request: Request;
  status: number;
  durationMs: number;
  bypassed?: boolean;
}): void {
  const thresholdMs = slowRequestThresholdMs();
  if (thresholdMs === 0 || input.durationMs < thresholdMs) return;
  const url = new URL(input.request.url);
  console.log(
    JSON.stringify({
      event: "vpg.request.slow",
      method: input.request.method,
      path: url.pathname,
      status: input.status,
      duration_ms: Math.round(input.durationMs),
      runtime_bypassed: Boolean(input.bypassed),
    }),
  );
}

function withSecurityHeaders(
  response: Response,
  request: Request,
  options: { setCsrfCookie?: boolean } = {},
): Response {
  const setCsrfCookie = options.setCsrfCookie ?? true;
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  const url = new URL(request.url);
  const csp = contentSecurityPolicyForResponse({
    contentType: headers.get("content-type"),
    pathname: url.pathname,
    dev: import.meta.env.DEV,
  });
  if (csp && !headers.has("content-security-policy")) {
    headers.set("content-security-policy", csp);
  }
  const hsts = strictTransportSecurityForRequest({
    protocol: url.protocol,
    dev: import.meta.env.DEV,
  });
  if (hsts) headers.set("strict-transport-security", hsts);
  if (setCsrfCookie && !readCookie(request, csrfCookieName)) {
    headers.append("set-cookie", csrfCookie(randomCsrfToken(), request));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Astro middleware (Plan 011 §4): with D1's per-statement atomicity,
// the legacy mutation-lock + snapshot-refresh dance is gone. The
// middleware is now just three things:
//   1. CSRF / same-origin gate for browser-class mutations.
//   2. Bindings-present gate via ensureRuntimeReady().
//   3. Security headers + Server-Timing on every response.
export const onRequest = defineMiddleware(async (context, next) => {
  const startedAt = performance.now();
  const url = new URL(context.request.url);

  // Bypass list (OAuth, MCP, SSE, .well-known). Bearer-authenticated paths
  // don't share the cookie-CSRF mechanism, and the runtime-ready gate
  // would add latency without value.
  if (
    bypassesRuntimePersistence({
      method: context.request.method,
      pathname: url.pathname,
    })
  ) {
    const response = withSecurityHeaders(await next(), context.request, {
      setCsrfCookie: false,
    });
    const durationMs = performance.now() - startedAt;
    logSlowRequest({
      request: context.request,
      status: response.status,
      durationMs,
      bypassed: true,
    });
    return withServerTiming(response, durationMs);
  }

  await ensureRuntimeReady();

  // CSRF gates the cookie-authenticated browser. Bearer-token API clients
  // (CLI, agents, integrations) don't share the cookie attack surface, so
  // they're exempt — that's the same model gh / wrangler / aws-cli use.
  if (
    !hasBearerAuth(context.request) &&
    browserMutationMethods.has(context.request.method) &&
    (!sameOrigin(context.request) || !validCsrfToken(context.request))
  ) {
    return withSecurityHeaders(
      Response.json(
        {
          error: {
            code: "CSRF_BLOCKED",
            message: "Cross-site browser mutations are not allowed.",
          },
        },
        { status: 403 },
      ),
      context.request,
    );
  }

  const response = withSecurityHeaders(await next(), context.request);
  const durationMs = performance.now() - startedAt;
  logSlowRequest({
    request: context.request,
    status: response.status,
    durationMs,
  });
  return withServerTiming(response, durationMs);
});
