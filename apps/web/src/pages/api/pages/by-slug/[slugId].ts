import type { APIRoute } from "astro";
import { pages as pagesService } from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    const page = params.slugId
      ? await pagesService.getBySlugId(ctx, params.slugId)
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
