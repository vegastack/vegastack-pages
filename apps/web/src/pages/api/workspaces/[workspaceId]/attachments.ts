import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  attachmentService,
  ensureSeedData,
  pageService,
  permissionService,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
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
    permissionService.assert({ actual: permission, required: "admin" });
    const pages = pageService.listPages(workspaceId);
    return Response.json({
      attachments: pages.flatMap((page) =>
        attachmentService.listForPage(page.id).map((attachment) => ({
          ...attachment,
          page_title: page.title,
          page_slug_id: page.slugId,
          url: `/api/attachments/${attachment.id}?workspace_id=${encodeURIComponent(workspaceId)}`,
        })),
      ),
    });
  } catch (error) {
    return jsonAppError(error, "Workspace attachment listing failed.");
  }
};
