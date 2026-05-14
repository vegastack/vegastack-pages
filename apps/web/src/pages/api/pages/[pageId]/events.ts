import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  ensureSeedData,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.pageId
      ? await pageService.getPage(params.pageId)
      : null;
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const afterId = url.searchParams.get("after_id");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return Response.json({
      events: reviewEventService.list({
        pageId: page.page.id,
        afterId,
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  } catch (error) {
    return jsonAppError(error, "Event listing failed.");
  }
};
