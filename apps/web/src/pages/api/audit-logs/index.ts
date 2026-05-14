import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../lib/access";
import {
  auditService,
  ensureSeedData,
  permissionService,
  workspaceService,
} from "../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    await ensureSeedData();
    const workspaceId = url.searchParams.get("workspace_id") ?? undefined;
    const actor = await getApiRequestActor(cookies, request);
    if (workspaceId) {
      const member = actor.user
        ? workspaceService.getMember(workspaceId, actor.user.id)
        : null;
      const permission =
        actor.workspaceId && actor.workspaceId !== workspaceId
          ? "none"
          : permissionService.resolve({
              user: actor.user,
              member,
              workspaceId,
            });
      permissionService.assert({ actual: permission, required: "admin" });
    } else {
      permissionService.assert({
        actual:
          !actor.workspaceId && actor.user?.role === "instance_admin"
            ? "admin"
            : "none",
        required: "admin",
      });
    }
    return Response.json({
      logs: auditService.list({
        workspaceId,
        afterId: url.searchParams.get("after_id") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 100),
      }),
    });
  } catch (error) {
    return jsonAppError(error, "Audit log listing failed.");
  }
};
