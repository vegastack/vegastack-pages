import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  comments as commentsService,
  pages as pagesService,
  reviewEvents,
  isServiceError,
  requireDb,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { scheduleIndexCommentThread } from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

async function lookupThreadPageId(
  ctx: Awaited<ReturnType<typeof buildServiceContext>>["ctx"],
  threadId: string,
): Promise<string | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare("SELECT page_id FROM comment_threads WHERE id = ?1")
    .bind(threadId)
    .first<{ page_id: string }>();
  return row?.page_id ?? null;
}

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const threadId = params.threadId ?? "";
    const bootstrap = await buildServiceContext({ cookies, request });
    const pageId = await lookupThreadPageId(bootstrap.ctx, threadId);
    if (!pageId) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    const page = await pagesService.get(bootstrap.ctx, pageId);
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "comment",
    });
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const result = await commentsService.resolve(ctx, {
      threadId,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
    });
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.resolved",
      actorUserId: access.actor.user?.id ?? null,
      payload: { thread_id: result.data.id },
    });
    scheduleIndexCommentThread(result.data.id);
    return Response.json({ thread: result.data, envelope: result.envelope });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Resolve failed.");
  }
};
