import { defineMiddleware } from "astro:middleware";
import {
  acquireRuntimeMutationLock,
  ensureRuntimeReady,
  persistRuntimeState,
  pruneExpiredVersions,
  refreshRuntimeState,
} from "./lib/runtime";
import {
  csrfCookie,
  csrfCookieName,
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

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const browserMutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const defaultSlowRequestMs = 1_000;

function slowRequestThresholdMs() {
  const configured = Number(process.env.VPG_SLOW_REQUEST_LOG_MS ?? "");
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : defaultSlowRequestMs;
}

function withServerTiming(response: Response, durationMs: number) {
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
}) {
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
) {
  const setCsrfCookie = options.setCsrfCookie ?? true;
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  const url = new URL(request.url);
  const csp = contentSecurityPolicyForResponse({
    contentType: headers.get("content-type"),
    pathname: url.pathname,
  });
  if (csp && !headers.has("content-security-policy")) {
    headers.set("content-security-policy", csp);
  }
  const hsts = strictTransportSecurityForRequest({
    protocol: url.protocol,
    dev: import.meta.env.DEV,
  });
  if (hsts) {
    headers.set("strict-transport-security", hsts);
  }
  if (setCsrfCookie && !readCookie(request, csrfCookieName)) {
    headers.append("set-cookie", csrfCookie(randomCsrfToken(), request));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const startedAt = performance.now();
  const url = new URL(context.request.url);
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
  if (
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

  if (!mutatingMethods.has(context.request.method)) {
    await refreshRuntimeState({ force: false });
    const response = withSecurityHeaders(await next(), context.request);
    const durationMs = performance.now() - startedAt;
    logSlowRequest({
      request: context.request,
      status: response.status,
      durationMs,
    });
    return withServerTiming(response, durationMs);
  }

  const lock = await acquireRuntimeMutationLock();
  try {
    await refreshRuntimeState({ force: true });
    const response = await next();

    if (response.status < 400) {
      await pruneExpiredVersions();
      await persistRuntimeState();
    }

    const secured = withSecurityHeaders(response, context.request);
    const durationMs = performance.now() - startedAt;
    logSlowRequest({
      request: context.request,
      status: secured.status,
      durationMs,
    });
    return withServerTiming(secured, durationMs);
  } finally {
    await lock.release();
  }
});
