// Build a ServiceContext from a route handler's parameters.
//
// Every route that consumes @vegastack/pages-services constructs the
// same shape: actor identity + the in-memory repo registry + a
// no-op waitUntil + a no-op log. This helper factors that out so
// route handlers stay focused on HTTP-layer concerns (validation,
// status codes, envelope shaping) and delegate everything else to
// the service layer.
//
// When the D1 adapters land in Workstream A, this is the single
// place that switches between in-memory and D1 implementations.
// Routes don't change.
//
// Plan: docs/plans/007-instant-workspace-architecture.md §F.

import { isServiceError, type ServiceContext } from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError, type RequestActor } from "./access";
import { repos } from "./runtime/repos";
import { buildWorkspaceNavigation } from "./workspace-navigation";

export type RouteServiceContextInput = {
  cookies: Parameters<typeof getApiRequestActor>[0];
  request?: Request;
  workspaceId?: string | null;
};

// Build a ServiceContext from a Route's cookies + request. The actor's
// workspaceId defaults to the actor's bound workspace; pass an explicit
// workspaceId to override when the route operates on a specific
// workspace different from the actor's default.
export async function buildServiceContext(
  input: RouteServiceContextInput,
): Promise<{ ctx: ServiceContext; actor: RequestActor }> {
  const actor = await getApiRequestActor(input.cookies, input.request);
  const workspaceId = input.workspaceId ?? actor.workspaceId ?? null;
  const ctx: ServiceContext = {
    actor: {
      userId: actor.user?.id ?? "",
      email: actor.user?.email ?? null,
      workspaceId,
    },
    session: {
      bookmark: null,
      prepare: () => {
        throw new Error(
          "ServiceContext.session is D1-only and not available in this adapter.",
        );
      },
      batch: async () => {
        throw new Error(
          "ServiceContext.session is D1-only and not available in this adapter.",
        );
      },
    },
    repo: repos,
    async computeTreeVersion(targetWorkspaceId: string) {
      // Recomputes the workspace navigation hash from the post-write
      // in-memory state. Cheap on the current in-memory adapter (one
      // listFolders + listPages + sort + hash). When the D1-direct
      // adapter lands, this becomes the per-request cached lookup.
      return buildWorkspaceNavigation(actor, targetWorkspaceId).treeVersion;
    },
    waitUntil(promise: Promise<unknown>) {
      // Local fallback: run the promise and log any rejection so
      // failures aren't silently dropped. The Cloudflare adapter will
      // forward to the runtime's ctx.waitUntil() when wired.
      void promise.catch((err) => {
        console.warn("[vpg-service] waitUntil rejected:", err);
      });
    },
    log(level, message, fields) {
      const emit =
        level === "error" || level === "warn" ? console.error : console.log;
      emit(`[vpg-service] [${level}] ${message}`, fields ?? {});
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
