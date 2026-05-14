import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { enrichReply } from "../../../../lib/comments-enrich";
import { guestSessionForPublication } from "../../../../lib/guest-session";
import {
  commentService,
  ensureSeedData,
  indexCommentThread,
  pageService,
  publicationService,
  reviewEventService,
} from "../../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const body = await request.json();
    const thread = commentService.getThread(params.threadId ?? "");
    if (!thread)
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    const page = await pageService.getPage(thread.thread.pageId);
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    if (body.agent) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Agent reply metadata is only accepted through authenticated MCP flows.",
        403,
      );
    }
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "comment",
      guestName: body.guest_name ? String(body.guest_name) : null,
    });
    let guestSession = null;
    if (!access.actor.user) {
      const publication = access.publicationId
        ? publicationService.get(access.publicationId)
        : null;
      if (!publication) {
        throw new AppError(
          "AUTH_REQUIRED",
          "A public publication is required for guest replies.",
          401,
        );
      }
      guestSession = await guestSessionForPublication({
        cookies,
        url,
        publication,
        requestedName: body.guest_name ? String(body.guest_name) : null,
      });
    }
    const reply = commentService.reply({
      threadId: params.threadId ?? "",
      body: String(body.body ?? ""),
      authorType: access.actor.user ? "user" : "guest",
      authorUserId: access.actor.user?.id ?? null,
      guestName: guestSession?.guestName ?? null,
      guestSessionId: guestSession?.id ?? null,
      publicationId: guestSession?.publicationId ?? null,
      agent: null,
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
    await indexCommentThread(thread.thread.id);
    return Response.json({ reply: enrichReply(reply) });
  } catch (error) {
    return jsonAppError(error, "Reply failed.");
  }
};
