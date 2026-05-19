import type { APIRoute } from "astro";
import {
  audit,
  pages as pagesService,
  reviewEvents,
} from "@vegastack/pages-services";
import { resolvePageAccess } from "../../../../lib/access";
import { scheduleIndexPage } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
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
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const versions = await pagesService.listVersions(ctx, {
      pageId: page.page.id,
    });
    return Response.json({ versions });
  } catch (error) {
    return serviceErrorToResponse(error, "Version listing failed.");
  }
};

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
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
    });
    const body = await request.json();
    const versionId = String(body.version_id ?? "");
    const result = await pagesService.restoreVersion(ctx, {
      pageId: page.page.id,
      versionId,
    });
    const restored = result.data;
    scheduleIndexPage(page.page.id);
    await audit.record(ctx, {
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
    await reviewEvents.emit(ctx, {
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
    return serviceErrorToResponse(error, "Version restore failed.");
  }
};
