import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { ensureSeedData, pageService } from "../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.slugId
      ? await pageService.getPageBySlugId(params.slugId)
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
      page_id: page.page.id,
      workspace_id: page.page.workspaceId,
      title: page.page.title,
      slug_id: page.page.slugId,
      url: `/p/${page.page.slugId}`,
      version_id: page.page.versionId,
    });
  } catch (error) {
    return jsonAppError(error, "Page lookup failed.");
  }
};
