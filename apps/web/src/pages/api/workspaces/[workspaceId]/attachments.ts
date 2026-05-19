import type { APIRoute } from "astro";
import {
  attachments,
  pages as pagesService,
  permissions as permissionsService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
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
    const pages = await pagesService.list(ctx, workspaceId);
    const grouped = await Promise.all(
      pages.map(async (page) => {
        const list = await attachments.listForPage(ctx, { pageId: page.id });
        return list.map((attachment) => ({
          ...attachment,
          page_title: page.title,
          page_slug_id: page.slugId,
          url: `/api/attachments/${attachment.id}?workspace_id=${encodeURIComponent(workspaceId)}`,
        }));
      }),
    );
    return Response.json({ attachments: grouped.flat() });
  } catch (error) {
    return serviceErrorToResponse(
      error,
      "Workspace attachment listing failed.",
    );
  }
};
