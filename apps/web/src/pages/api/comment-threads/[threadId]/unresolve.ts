import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  commentService,
  ensureSeedData,
  scheduleIndexCommentThread,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
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
      required: "comment",
    });
    const unresolved = commentService.unresolve(params.threadId ?? "");
    reviewEventService.emit({
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.unresolved",
      actorUserId: access.actor.user?.id ?? null,
      payload: { thread_id: unresolved.id },
    });
    scheduleIndexCommentThread(unresolved.id);
    return Response.json({ thread: unresolved });
  } catch (error) {
    return jsonAppError(error, "Unresolve failed.");
  }
};
