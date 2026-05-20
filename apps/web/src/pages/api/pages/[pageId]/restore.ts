// Restore a soft-deleted page. Editors+ on the workspace can restore;
// matches the permission decision for the trash window. We DO read
// soft-deleted rows here (the whole point of restore).

import type { APIRoute } from "astro";
import {
  audit,
  pages as pagesService,
  permissions as permissionsService,
  reviewEvents,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
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
      ? await pagesService.get(ctx, params.pageId, { includeDeleted: true })
      : null;
    if (!page) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    if (!page.page.deletedAt) {
      return Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Page is not in the trash.",
          },
        },
        { status: 400 },
      );
    }
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
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

    const restored = await pagesService.restore(ctx, page.page.id);
    await audit.record(ctx, {
      workspaceId: restored.data.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "page.restored",
      targetType: "page",
      targetId: restored.data.id,
      metadata: { title: restored.data.title },
    });
    await reviewEvents.emit(ctx, {
      workspaceId: restored.data.workspaceId,
      pageId: restored.data.id,
      type: "page.restored",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        page_id: restored.data.id,
        title: restored.data.title,
        source: "trash",
      },
    });
    return Response.json({ page: restored.data, envelope: restored.envelope });
  } catch (error) {
    return serviceErrorToResponse(error, "Page restore failed.");
  }
};
