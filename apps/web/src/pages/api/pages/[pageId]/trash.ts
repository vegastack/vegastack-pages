// Trash actions for a page:
//   POST   /api/pages/:id/trash         → soft-delete (editor+)
//   DELETE /api/pages/:id/trash         → hard-delete from trash (admin only)
//
// Restore lives in a sibling route (./restore.ts) so the URL reads
// naturally ("POST /restore"). Soft-delete uses POST so any existing
// "POST a verb noun" idiom in this repo stays consistent.

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

async function loadPageAndAssert(
  cookies: any,
  request: Request,
  url: URL,
  pageId: string | undefined,
  required: "write" | "admin",
  options: { includeDeleted?: boolean } = {},
) {
  const { ctx } = await buildServiceContext({ cookies, request });
  const page = pageId
    ? await pagesService.get(ctx, pageId, {
        includeDeleted: options.includeDeleted,
      })
    : null;
  if (!page) return { error: 404 as const };
  const access = await resolvePageAccess({
    cookies,
    request,
    url,
    page: page.page,
    required,
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
    required,
  });
  return { ctx, page, access };
}

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const loaded = await loadPageAndAssert(
      cookies,
      request,
      url,
      params.pageId,
      "write",
    );
    if ("error" in loaded) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const { ctx, page, access } = loaded;
    const deleted = await pagesService.softDelete(ctx, page.page.id);
    await audit.record(ctx, {
      workspaceId: page.page.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "page.soft_deleted",
      targetType: "page",
      targetId: page.page.id,
      metadata: { title: page.page.title },
    });
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "page.deleted",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        page_id: page.page.id,
        title: page.page.title,
        source: "trash",
      },
    });
    return Response.json({ page: deleted.data, envelope: deleted.envelope });
  } catch (error) {
    return serviceErrorToResponse(error, "Page delete failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const loaded = await loadPageAndAssert(
      cookies,
      request,
      url,
      params.pageId,
      "admin",
      { includeDeleted: true },
    );
    if ("error" in loaded) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const { ctx, page, access } = loaded;
    const result = await pagesService.hardDelete(ctx, page.page.id);
    await audit.record(ctx, {
      workspaceId: result.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "page.hard_deleted",
      targetType: "page",
      targetId: result.pageId,
      metadata: { title: page.page.title },
    });
    return Response.json({ ok: true, page_id: result.pageId });
  } catch (error) {
    return serviceErrorToResponse(error, "Permanent delete failed.");
  }
};
