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
  scheduleIndexCommentThread,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

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
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const replyResult = await commentsService.reply(ctx, {
      threadId: thread.thread.id,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
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
    const reply = replyResult.data;
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
    // If we also resolved the thread, merge the resolve envelope's
    // changed_resources into the reply envelope so clients invalidate
    // both the reply cache and the thread-status cache.
    let envelope = replyResult.envelope;
    if (Boolean(body.resolve)) {
      const resolveResult = await commentsService.resolve(ctx, {
        threadId: thread.thread.id,
        pageId: page.page.id,
        workspaceId: page.page.workspaceId,
      });
      resolved = resolveResult.data;
      reviewEventService.emit({
        workspaceId: page.page.workspaceId,
        pageId: page.page.id,
        type: "comment.resolved",
        actorUserId: access.actor.user?.id ?? null,
        payload: { thread_id: resolved.id },
      });
      envelope = {
        // Use the post-resolve tree version (resolve ran last).
        tree_version: resolveResult.envelope.tree_version,
        content_hash:
          resolveResult.envelope.content_hash ??
          replyResult.envelope.content_hash,
        navigation_invalidated:
          replyResult.envelope.navigation_invalidated ||
          resolveResult.envelope.navigation_invalidated,
        changed_resources: [
          ...new Set([
            ...replyResult.envelope.changed_resources,
            ...resolveResult.envelope.changed_resources,
          ]),
        ],
      };
    }
    scheduleIndexCommentThread(thread.thread.id);
    return Response.json({
      reply,
      resolved,
      thread: commentService.getThread(thread.thread.id),
      envelope,
    });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Thread completion failed.");
  }
};
