import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  ensureSeedData,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.pageId
      ? await pageService.getPage(params.pageId)
      : null;
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    const body = await request.json();
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
    });
    const updated = await pageService.updateSource({
      pageId: page.page.id,
      source: page.source,
      baseVersionId: page.page.versionId,
      checkpoint: true,
      checkpointLabel: body.label ? String(body.label) : "Manual snapshot",
    });
    reviewEventService.emit({
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "page.version_created",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        version_id: updated.page.versionId,
        label: body.label ?? null,
      },
    });
    return Response.json({
      page_id: updated.page.id,
      version_id: updated.page.versionId,
      updated_at: updated.page.updatedAt,
      checkpoint_created: updated.checkpointCreated,
    });
  } catch (error) {
    return jsonAppError(error, "Snapshot failed.");
  }
};
