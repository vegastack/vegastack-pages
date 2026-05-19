import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  buildEnvelope,
  folders as foldersService,
  jsonWithEnvelope,
  pages as pagesService,
  permissions as permissionsService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function assertWorkspaceAdmin(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  workspaceId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
  const { ctx } = await buildServiceContext({
    cookies,
    request,
    workspaceId,
  });
  const member = actor.user
    ? await workspacesService.getMember(ctx, {
        workspaceId,
        userId: actor.user.id,
      })
    : null;
  const permission =
    actor.workspaceId && actor.workspaceId !== workspaceId
      ? "none"
      : await permissionsService.resolve(ctx, {
          workspaceId,
          userId: actor.user?.id ?? "",
          scope: "workspace",
          targetId: workspaceId,
          memberRole: member?.role ?? null,
          instanceRole: actor.user?.role,
        });
  permissionsService.assertLevel({ actual: permission, required: "admin" });
  return actor;
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    await assertWorkspaceAdmin(cookies, request, workspaceId);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    let workspace;
    try {
      workspace = await workspacesService.get(ctx, { workspaceId });
    } catch {
      workspace = null;
    }
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
    const [pages, members, folders] = await Promise.all([
      pagesService.list(ctx, workspaceId),
      workspacesService.listMembers(ctx, { workspaceId }),
      foldersService.listAll(ctx, { workspaceId }),
    ]);
    return Response.json({
      workspace,
      counts: {
        members: members.length,
        folders: folders.length,
        pages: pages.length,
      },
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace settings fetch failed.");
  }
};

export const PATCH: APIRoute = async ({ cookies, params, request }) => {
  try {
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
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const workspace = await workspacesService.update(ctx, {
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
    await audit.record(ctx, {
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
    // Workspace name/slug change is visible in the breadcrumb root; the
    // shell uses tree_version to detect this. Slug changes also affect any
    // cached workspace URL.
    const treeVersion = (await buildWorkspaceNavigation(actor, workspaceId))
      .treeVersion;
    return jsonWithEnvelope(
      { workspace },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`workspace:${workspaceId}`],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace settings update failed.");
  }
};
