import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  pageService,
  permissionService,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

async function assertWorkspaceAdmin(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  workspaceId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
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
  return actor;
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    await assertWorkspaceAdmin(cookies, request, workspaceId);
    const workspace = workspaceService.getWorkspace(workspaceId);
    if (!workspace)
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
        {
          parameter: "workspaceId",
          location: "path",
        },
      );
    return Response.json({
      workspace,
      counts: {
        members: workspaceService.listMembers(workspaceId).length,
        folders: workspaceService.listFolders(workspaceId).length,
        pages: pageService.listPages(workspaceId).length,
      },
    });
  } catch (error) {
    return jsonAppError(error, "Workspace settings fetch failed.");
  }
};

export const PATCH: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertWorkspaceAdmin(cookies, request, workspaceId);
    const body = await request.json();
    const retention =
      body.version_retention_days === undefined
        ? undefined
        : body.version_retention_days === null ||
            body.version_retention_days === ""
          ? null
          : Number(body.version_retention_days);
    if (
      retention !== undefined &&
      retention !== null &&
      (!Number.isFinite(retention) || retention < 1 || retention > 3650)
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Version retention must be between 1 and 3650 days.",
        400,
      );
    }
    const workspace = workspaceService.updateWorkspace({
      workspaceId,
      name: body.name === undefined ? undefined : String(body.name),
      slug: body.slug === undefined ? undefined : String(body.slug),
      versionRetentionDays:
        retention === undefined
          ? undefined
          : retention === null
            ? null
            : Math.round(retention),
    });
    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "workspace.settings_updated",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: {
        name: workspace.name,
        slug: workspace.slug,
        version_retention_days: workspace.versionRetentionDays,
      },
    });
    return Response.json({ workspace });
  } catch (error) {
    return jsonAppError(error, "Workspace settings update failed.");
  }
};
