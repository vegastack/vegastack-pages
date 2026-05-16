// Build a ServiceContext from a route handler's parameters.
//
// Every route that consumes @vegastack/pages-services constructs the
// same shape: actor identity + the in-memory repo registry + waitUntil
// + log. This helper factors that out so route handlers stay focused
// on HTTP-layer concerns (validation, status codes, envelope shaping)
// and delegate everything else to the service layer.

import { isServiceError, type ServiceContext } from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError, type RequestActor } from "./access";
import { repos } from "./runtime/repos";
import { buildWorkspaceNavigation } from "./workspace-navigation";

export type RouteServiceContextInput = {
  cookies: Parameters<typeof getApiRequestActor>[0];
  request?: Request;
  workspaceId?: string | null;
};

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
    repo: repos,
    async computeTreeVersion(targetWorkspaceId: string) {
      return buildWorkspaceNavigation(actor, targetWorkspaceId).treeVersion;
    },
    waitUntil(promise: Promise<unknown>) {
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
