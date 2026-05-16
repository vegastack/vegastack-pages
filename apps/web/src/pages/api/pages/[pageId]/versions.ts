import type { APIRoute } from "astro";
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
  reviewEventService,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
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
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    return Response.json({
      versions: pageService.listVersions(page.page.id),
    });
  } catch (error) {
    return jsonAppError(error, "Version listing failed.");
  }
};

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
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
    });
    const body = await request.json();
    const versionId = String(body.version_id ?? "");
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const result = await pagesService.restoreVersion(ctx, {
      pageId: page.page.id,
      versionId,
    });
    const restored = result.data;
    scheduleIndexPage(page.page.id);
    auditService.record({
      workspaceId: page.page.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "page.version_restored",
      targetType: "page",
      targetId: page.page.id,
      metadata: {
        version_id: versionId,
        restored_version_id: restored.page.versionId,
      },
    });
    reviewEventService.emit({
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "page.version_created",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        restored_from_version_id: versionId,
        version_id: restored.page.versionId,
      },
    });
    return Response.json({ page: restored.page, envelope: result.envelope });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Version restore failed.");
  }
};
