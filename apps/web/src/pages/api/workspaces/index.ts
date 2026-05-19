import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  buildEnvelope,
  jsonWithEnvelope,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../lib/access";
import { listSelectableWorkspaces } from "../../../lib/workspace-visibility";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../lib/workspace-navigation";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request }) => {
  try {
    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Authentication is required.", 401);
    }
    const workspaces = (await listSelectableWorkspaces(actor.user)).filter(
      (workspace) => !actor.workspaceId || workspace.id === actor.workspaceId,
    );
    return Response.json({
      workspaces,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, request }) => {
  try {
    const actor = await getApiRequestActor(cookies, request);
    if (actor.user?.role !== "instance_admin") {
      throw new AppError(
        "PERMISSION_DENIED",
        "Only instance admins can create workspaces.",
        403,
      );
    }
    const body = await request.json();
    const { ctx } = await buildServiceContext({ cookies, request });
    const workspace = await workspacesService.create(ctx, {
      name: String(body.name ?? ""),
      slug: body.slug ? String(body.slug) : "",
      firstAdminUserId: actor.user.id,
    });
    await audit.record(ctx, {
      workspaceId: workspace.id,
      actorUserId: actor.user.id,
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { name: workspace.name },
    });
    // The launcher / workspace switcher cache MUST be invalidated when
    // a new workspace appears, so clients refresh their workspace list.
    const treeVersion = (await buildWorkspaceNavigation(actor, workspace.id))
      .treeVersion;
    return jsonWithEnvelope(
      {
        workspace_id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [
          `workspace:${workspace.id}`,
          `members:${workspace.id}`,
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace creation failed.");
  }
};
