// Build a ServiceContext from a route handler's parameters.
//
// Every route that consumes @vegastack/pages-services constructs the
// same shape: actor identity + D1 handle + object store + waitUntil
// + log. This helper factors that out so route handlers stay focused
// on HTTP-layer concerns (validation, status codes, envelope shaping)
// and delegate everything else to the service layer.

import { isServiceError, type ServiceContext } from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError, type RequestActor } from "./access";
import { scheduleBackgroundTask } from "./background";
import { getDb, getObjectStore } from "./runtime";
import { buildWorkspaceNavigation } from "./workspace-navigation";

export type RouteServiceContextInput = {
  // Astro routes pass `Astro.cookies` (or APIContext.cookies); tests
  // sometimes omit cookies entirely on anonymous routes. The downstream
  // actor resolver treats undefined as anonymous.
  cookies?: Parameters<typeof getApiRequestActor>[0];
  request?: Request;
  workspaceId?: string | null;
};

export async function buildServiceContext(
  input: RouteServiceContextInput,
): Promise<{ ctx: ServiceContext; actor: RequestActor }> {
  const actor = await getApiRequestActor(input.cookies, input.request);
  const workspaceId = input.workspaceId ?? actor.workspaceId ?? null;
  const [db, objectStore] = await Promise.all([getDb(), getObjectStore()]);
  // Public origin (https://host) used by services that purge the edge
  // cache. Derived from the inbound request URL so we always purge the
  // colo that served the page being mutated; falls back to the
  // VPG_BASE_URL env var for background work (cron, scheduled tasks).
  const publicOrigin = input.request
    ? new URL(input.request.url).origin
    : (process.env.VPG_BASE_URL?.replace(/\/+$/, "") ?? undefined);
  const ctx: ServiceContext = {
    actor: {
      userId: actor.user?.id ?? "",
      email: actor.user?.email ?? null,
      workspaceId,
    },
    db: db ?? undefined,
    objectStore,
    publicOrigin,
    async computeTreeVersion(targetWorkspaceId: string) {
      const nav = await buildWorkspaceNavigation(actor, targetWorkspaceId);
      return nav.treeVersion;
    },
    waitUntil(promise: Promise<unknown>) {
      // Route through scheduleBackgroundTask so the promise is actually
      // registered with Cloudflare's runtime (via the per-request
      // AsyncLocalStorage waitUntil). The previous implementation only
      // attached a .catch logger and never told Cloudflare to keep the
      // isolate alive — meaning publication cache purges and similar
      // post-response work could be torn down silently. (Audit cycle 5.)
      scheduleBackgroundTask("ctx.waitUntil", () => promise);
    },
    log(level, message, fields) {
      // Single-line JSON-structured log so observability tooling
      // (Sentry, Logflare, Cloudflare Logpush, etc.) can index the
      // `event` field uniformly without parsing freeform strings.
      // All `ctx.log` callers use a short snake_case `message` slug
      // — promote it to `event` and let `level` live as a top-level
      // field so log shippers can filter on severity.
      console.log(
        JSON.stringify({
          event: message,
          level,
          ...(fields ?? {}),
        }),
      );
    },
  };
  return { ctx, actor };
}

// Translate a ServiceError or any unexpected error into the route's JSON
// response. Every migrated route uses the same shape; centralizing it
// here keeps the route handlers focused on business intent rather than
// error plumbing.
export function serviceErrorToResponse(
  error: unknown,
  fallbackMessage: string,
): Response {
  if (isServiceError(error)) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }
  return jsonAppError(error, fallbackMessage);
}
