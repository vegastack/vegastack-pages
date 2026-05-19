import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { pages as pagesService, reviewEvents } from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    const page = params.pageId
      ? await pagesService.get(ctx, params.pageId)
      : null;
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const afterId = url.searchParams.get("after_id") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return Response.json({
      events: await reviewEvents.list(ctx, {
        workspaceId: page.page.workspaceId,
        pageId: page.page.id,
        afterId,
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  } catch (error) {
    return jsonAppError(error, "Event listing failed.");
  }
};
