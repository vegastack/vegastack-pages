import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { pages as pagesService, reviewEvents } from "@vegastack/pages-services";
import { resolvePageAccess } from "../../../../lib/access";
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
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    const body = await request.json();
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
    });
    // Manual snapshot: write the existing source through updateSource with
    // checkpoint=true. The service returns the new versionId.
    const result = await pagesService.updateSource(ctx, {
      pageId: page.page.id,
      source: page.source,
      baseVersionId: page.page.versionId,
      checkpoint: true,
      checkpointLabel: body.label ? String(body.label) : "Manual snapshot",
    });
    const updated = result.data;
    await reviewEvents.emit(ctx, {
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
      envelope: {
        ...result.envelope,
        // Manual snapshot doesn't actually invalidate nav since the source
        // didn't change. The service infers it from updated.changed, but
        // for the snapshot semantics we want to explicitly state false.
        navigation_invalidated: false,
      },
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Snapshot failed.");
  }
};
