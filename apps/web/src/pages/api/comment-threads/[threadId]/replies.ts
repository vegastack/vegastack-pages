import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  comments as commentsService,
  pages as pagesService,
  publications,
  rateLimit,
  reviewEvents,
  isServiceError,
  requireDb,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { clientRateLimitKey } from "../../../../lib/client-address";
import { enrichReply } from "../../../../lib/comments-enrich";
import { guestSessionForPublication } from "../../../../lib/guest-session";
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
    const body = await request.json();
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
    // Anti-spam on guest reply posts. Authenticated members reuse the
    // same key so the limit covers both surfaces without favouring the
    // higher-trust path explicitly.
    await rateLimit.check(bootstrap.ctx, {
      key: `comment-reply:${access.actor.user?.id ?? clientRateLimitKey(request, "guest")}:${threadId}`,
      limit: 20,
      windowMs: 60 * 60_000,
    });
    let guestSession = null;
    if (!access.actor.user) {
      const publication = access.publicationId
        ? await publications.get(bootstrap.ctx, access.publicationId)
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
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const result = await commentsService.reply(ctx, {
      threadId,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
      body: String(body.body ?? ""),
      authorType: access.actor.user ? "user" : "guest",
      authorUserId: access.actor.user?.id ?? null,
      guestName: guestSession?.guestName ?? null,
      guestSessionId: guestSession?.id ?? null,
      publicationId: guestSession?.publicationId ?? null,
      agent: null,
    });
    const reply = result.data;
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.replied",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        thread_id: threadId,
        reply_id: reply.id,
      },
    });
    scheduleIndexCommentThread(threadId);
    return Response.json({
      reply: await enrichReply(reply),
      envelope: result.envelope,
    });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Reply failed.");
  }
};
