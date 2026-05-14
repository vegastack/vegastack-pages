import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../lib/access";
import { publicSignupEnabled } from "../../../lib/deployment";
import { listSelectableWorkspaces } from "../../../lib/workspace-visibility";
import {
  auditService,
  ensureSeedData,
  workspaceService,
} from "../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request }) => {
  try {
    if (!publicSignupEnabled()) {
      await ensureSeedData();
    }
    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Authentication is required.", 401);
    }
    const workspaces = listSelectableWorkspaces(actor.user).filter(
      (workspace) => !actor.workspaceId || workspace.id === actor.workspaceId,
    );
    return Response.json({
      workspaces,
    });
  } catch (error) {
    return jsonAppError(error, "Workspace listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, request }) => {
  try {
    if (!publicSignupEnabled()) {
      await ensureSeedData();
    }
    const actor = await getApiRequestActor(cookies, request);
    if (actor.user?.role !== "instance_admin") {
      throw new AppError(
        "PERMISSION_DENIED",
        "Only instance admins can create workspaces.",
        403,
      );
    }
    const body = await request.json();
    const workspace = workspaceService.createWorkspace({
      name: String(body.name ?? ""),
      slug: body.slug ? String(body.slug) : undefined,
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: actor.user.id,
      role: "admin",
    });
    auditService.record({
      workspaceId: workspace.id,
      actorUserId: actor.user.id,
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { name: workspace.name },
    });
    return Response.json({
      workspace_id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    });
  } catch (error) {
    return jsonAppError(error, "Workspace creation failed.");
  }
};
