import type { APIRoute } from "astro";
import { AppError } from "@vegastack/pages-core";
import {
  pages as pagesService,
  isServiceError,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  scheduleIndexPage,
  pageService,
  permissionService,
  reviewEventService,
  workspaceService,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.pageId
      ? await pageService.getPage(params.pageId)
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
      ? workspaceService.getMember(page.page.workspaceId, access.actor.user.id)
      : null;
    const workspacePermission = permissionService.resolve({
      user: access.actor.user,
      member,
      workspaceId: page.page.workspaceId,
    });
    permissionService.assert({
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
      !workspaceService
        .listFolders(page.page.workspaceId)
        .some((folder) => folder.path === folderPath)
    ) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Folder was not found in this workspace.",
        404,
      );
    }
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const result = await pagesService.move(ctx, {
      pageId: page.page.id,
      title: body.title === undefined ? undefined : String(body.title),
      folderPath,
    });
    const updated = result.data;
    scheduleIndexPage(updated.id);
    auditService.record({
      workspaceId: updated.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "page.moved",
      targetType: "page",
      targetId: updated.id,
      metadata: { title: updated.title, folder_path: updated.folderPath },
    });
    reviewEventService.emit({
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
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Page move failed.");
  }
};
