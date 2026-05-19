import type { APIRoute } from "astro";
import { AppError } from "@vegastack/pages-core";
import {
  audit,
  folders as foldersService,
  pages as pagesService,
  permissions as permissionsService,
  reviewEvents,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { resolvePageAccess } from "../../../../lib/access";
import { scheduleIndexPage } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    const page = params.pageId
      ? await pagesService.get(ctx, params.pageId)
      : null;
    if (!page) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const body = await request.json();
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
      guestName: body.guest_name ? String(body.guest_name) : null,
    });
    const member = access.actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId: page.page.workspaceId,
          userId: access.actor.user.id,
        })
      : null;
    const workspacePermission = await permissionsService.resolve(ctx, {
      workspaceId: page.page.workspaceId,
      userId: access.actor.user?.id ?? "",
      scope: "workspace",
      targetId: page.page.workspaceId,
      memberRole: member?.role ?? null,
      instanceRole: access.actor.user?.role,
    });
    permissionsService.assertLevel({
      actual: workspacePermission,
      required: "write",
    });
    const folderPath =
      body.folder_path === undefined
        ? undefined
        : String(body.folder_path).replace(/^\/+|\/+$/g, "");
    // Route-layer validation: the existing API contract uses
    // FOLDER_NOT_FOUND (more specific than the service's generic
    // NOT_FOUND) so we keep this check here to preserve the contract.
    if (
      folderPath &&
      !(
        await foldersService.listAll(ctx, {
          workspaceId: page.page.workspaceId,
        })
      ).some(
        (folder) =>
          folder.path === folderPath ||
          folder.path === `/${folderPath}` ||
          folder.path.replace(/^\/+/, "") === folderPath,
      )
    ) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Folder was not found in this workspace.",
        404,
      );
    }
    const result = await pagesService.move(ctx, {
      pageId: page.page.id,
      title: body.title === undefined ? undefined : String(body.title),
      folderPath,
    });
    const updated = result.data;
    scheduleIndexPage(updated.id);
    await audit.record(ctx, {
      workspaceId: updated.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "page.moved",
      targetType: "page",
      targetId: updated.id,
      metadata: { title: updated.title, folder_path: updated.folderPath },
    });
    await reviewEvents.emit(ctx, {
      workspaceId: updated.workspaceId,
      pageId: updated.id,
      type: "page.moved",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        title: updated.title,
        folder_path: updated.folderPath,
        slug_id: updated.slugId,
      },
    });
    return Response.json({
      page: updated,
      url: `/p/${updated.slugId}`,
      envelope: result.envelope,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Page move failed.");
  }
};
