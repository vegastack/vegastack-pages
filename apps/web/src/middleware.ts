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

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const browserMutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function withSecurityHeaders(response: Response, request: Request) {
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
  if (!readCookie(request, csrfCookieName)) {
    headers.append("set-cookie", csrfCookie(randomCsrfToken(), request));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
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
    await refreshRuntimeState();
    return withSecurityHeaders(await next(), context.request);
  }

  const lock = await acquireRuntimeMutationLock();
  try {
    await refreshRuntimeState();
    const response = await next();

    if (response.status < 400) {
      await pruneExpiredVersions();
      await persistRuntimeState();
    }

    return withSecurityHeaders(response, context.request);
  } finally {
    await lock.release();
  }
});
