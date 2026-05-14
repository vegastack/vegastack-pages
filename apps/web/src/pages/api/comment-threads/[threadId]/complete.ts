import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  commentService,
  ensureSeedData,
  indexCommentThread,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const body = await request.json();
    const thread = commentService.getThread(params.threadId ?? "");
    if (!thread) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    const page = await pageService.getPage(thread.thread.pageId);
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "comment",
    });
    const reply = commentService.reply({
      threadId: thread.thread.id,
      body: String(body.body ?? ""),
      authorType: body.agent_name ? "agent" : "user",
      authorUserId: access.actor.user?.id ?? null,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      agent: body.agent_name
        ? {
            name: String(body.agent_name),
            model: body.agent_model ? String(body.agent_model) : "unknown",
            sessionId: body.agent_session_id
              ? String(body.agent_session_id)
              : "agt_api",
          }
        : null,
    });
    reviewEventService.emit({
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.replied",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        thread_id: thread.thread.id,
        reply_id: reply.id,
      },
    });
    let resolved = null;
    if (Boolean(body.resolve)) {
      resolved = commentService.resolve(thread.thread.id);
      reviewEventService.emit({
        workspaceId: page.page.workspaceId,
        pageId: page.page.id,
        type: "comment.resolved",
        actorUserId: access.actor.user?.id ?? null,
        payload: { thread_id: resolved.id },
      });
    }
    await indexCommentThread(thread.thread.id);
    return Response.json({
      reply,
      resolved,
      thread: commentService.getThread(thread.thread.id),
    });
  } catch (error) {
    return jsonAppError(error, "Thread completion failed.");
  }
};
