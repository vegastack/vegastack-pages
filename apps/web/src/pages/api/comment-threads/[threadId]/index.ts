import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  comments as commentsService,
  isServiceError,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  commentService,
  ensureSeedData,
  pageService,
  removeSearchResource,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const thread = commentService.getThread(params.threadId ?? "");
    if (!thread)
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    const page = await pageService.getPage(thread.thread.pageId);
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "admin",
    });
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const result = await commentsService.deleteThread(ctx, {
      threadId: params.threadId ?? "",
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
    });
    await removeSearchResource("comment_thread", result.data.id);
    return Response.json({ thread: result.data, envelope: result.envelope });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Comment deletion failed.");
  }
};
