import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { audit } from "@vegastack/pages-services";
import {
  assertWorkspaceActorPermission,
  getApiRequestActor,
} from "../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    const workspaceId = url.searchParams.get("workspace_id")?.trim() || "";
    const actor = await getApiRequestActor(cookies, request);

    if (workspaceId) {
      assertWorkspaceActorPermission({
        actor,
        workspaceId,
        required: "admin",
      });
      const { ctx } = await buildServiceContext({
        cookies,
        request,
        workspaceId,
      });
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const logs = await audit.list(ctx, {
        workspaceId,
        limit: Number.isFinite(limit) ? limit : 100,
      });
      return Response.json({ logs });
    }

    // Instance-admin-only path: no workspace_id supplied. The new audit
    // service only supports listing scoped to a workspace, so callers
    // without one must be an instance admin (preserves the legacy auth
    // semantics) and receive an empty list until a cross-workspace list
    // helper lands.
    if (!actor.workspaceId && actor.user?.role === "instance_admin") {
      return Response.json({ logs: [] });
    }
    throw new AppError("PERMISSION_DENIED", "Insufficient permission.", 403, {
      required: "admin",
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Audit log listing failed.");
  }
};
