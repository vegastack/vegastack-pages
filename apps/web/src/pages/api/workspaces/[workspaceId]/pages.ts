import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  pages as pagesService,
  isServiceError,
} from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  scheduleIndexPage,
  permissionService,
  reviewEventService,
  workspaceService,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const body = await request.json();
    const workspaceId = params.workspaceId?.trim();
    if (!workspaceId) {
      throw new AppError("VALIDATION_ERROR", "workspace id is required.", 400);
    }
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
    permissionService.assert({ actual: permission, required: "write" });
    const folder = body.folder_id
      ? workspaceService.getFolder(String(body.folder_id))
      : null;
    if (body.folder_id && (!folder || folder.workspaceId !== workspaceId)) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Folder was not found in this workspace.",
        404,
      );
    }
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const result = await pagesService.create(ctx, {
      workspaceId,
      folderPath:
        folder?.path ??
        (typeof body.folder_path === "string" ? body.folder_path : ""),
      title: String(body.title ?? "Untitled"),
      sourceType:
        body.source_type === "mdx" || body.source_type === "html"
          ? body.source_type
          : "markdown",
      source: String(body.source ?? ""),
    });
    const created = result.data;
    scheduleIndexPage(created.page.id);
    auditService.record({
      workspaceId: created.page.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "page.created",
      targetType: "page",
      targetId: created.page.id,
      metadata: {
        title: created.page.title,
        folder_path: created.page.folderPath,
      },
    });
    reviewEventService.emit({
      workspaceId: created.page.workspaceId,
      pageId: created.page.id,
      type: "page.created",
      actorUserId: actor.user?.id ?? null,
      payload: { title: created.page.title, slug_id: created.page.slugId },
    });

    return Response.json({
      page_id: created.page.id,
      slug_id: created.page.slugId,
      url: `/p/${created.page.slugId}`,
      version_id: created.page.versionId,
      envelope: result.envelope,
    });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Page creation failed.");
  }
};
