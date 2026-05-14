import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  commentService,
  ensureSeedData,
  pageService,
  removeSearchResource,
} from "../../../../lib/runtime";

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
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "admin",
    });
    const deleted = commentService.deleteThread(params.threadId ?? "");
    await removeSearchResource("comment_thread", deleted.id);
    return Response.json({ thread: deleted });
  } catch (error) {
    return jsonAppError(error, "Comment deletion failed.");
  }
};
