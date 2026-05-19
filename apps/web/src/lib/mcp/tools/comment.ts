import { AppError } from "@vegastack/pages-core";
import { comments, reviewEvents, search } from "@vegastack/pages-services";
import { coerceCommentAnchor } from "../../comment-anchor-api";
import { absoluteUrl, asString } from "../util";
import { getExistingPage, getThreadPage } from "../permissions";
import { agentReplyInput, findAnchoredIndex } from "../shared";
import type { McpToolContext } from "../types";

export async function createComment(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const page = await getExistingPage(
    context,
    asString(args.page_id),
    "comment",
    args.workspace_id,
  );
  const anchor = coerceCommentAnchor(args.anchor, {
    contentHash: page.page.contentHash,
  });
  if (anchor.sourceStart === null && anchor.selectedText.trim()) {
    const sourceStart = findAnchoredIndex(
      page.source,
      anchor.selectedText,
      anchor.prefixText,
      anchor.suffixText,
    );
    if (sourceStart >= 0) {
      anchor.sourceStart = sourceStart;
      anchor.sourceEnd = sourceStart + anchor.selectedText.length;
      anchor.selector = {
        ...(anchor.selector ?? {}),
        position: {
          ...(anchor.selector?.position ?? {}),
          sourceStart: anchor.sourceStart,
          sourceEnd: anchor.sourceEnd,
        },
      };
    }
  }
  const created = await comments.createThread(ctx, {
    pageId: page.page.id,
    workspaceId: page.page.workspaceId,
    body: asString(args.body),
    authorUserId: context.actor.user?.id ?? null,
    guestName: null,
    guestSessionId: null,
    publicationId: null,
    anchor,
  });
  await reviewEvents.emit(ctx, {
    workspaceId: page.page.workspaceId,
    pageId: page.page.id,
    type: "comment.created",
    actorUserId: context.actor.user?.id ?? null,
    payload: { thread_id: created.data.thread.id, source: "mcp" },
  });
  ctx.waitUntil(search.scheduleIndexCommentThread(ctx, created.data.thread.id));
  return {
    thread: created.data.thread,
    anchor: created.data.anchor,
    replies: created.data.replies,
    page: {
      id: page.page.id,
      title: page.page.title,
      sourceType: page.page.sourceType,
      contentHash: page.page.contentHash,
      url: absoluteUrl(context, `/p/${page.page.slugId}`),
    },
  };
}

// update_thread mutates a comment thread in one call: reply (`body`),
// resolve (`status: "resolved"` or `resolve: true`), reopen
// (`status: "open"`), anchor move (`anchor`), or completion-with-reply
// (`complete: true` + `body`). Multiple ops apply in this order:
// anchor → reply → resolve. Agent attribution fields
// (`agent_name`, `agent_model`, `agent_session_id`) tag the reply when set.
export async function updateThread(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const { thread, page } = await getThreadPage(
    context,
    asString(args.thread_id),
    "comment",
    args.workspace_id,
  );
  if (
    (args.status === "resolved" && args.resolve === false) ||
    (args.status === "open" && args.resolve === true)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "status and resolve cannot request opposite thread states.",
      400,
    );
  }

  // `complete: true` means "post a closing reply with agent attribution
  // and resolve the thread in one call." The agent instructions document
  // it; the previous code accepted the flag but did nothing with it
  // (audit cycle 5 finding). Map it onto the existing reply + resolve
  // path by forcing agent attribution and turning resolve on.
  if (args.resolve === undefined && args.status === undefined) {
    if (args.complete === true && asString(args.body, "").trim()) {
      (args as Record<string, unknown>).resolve = true;
      if (!args.agent_name && context.actor.user) {
        (args as Record<string, unknown>).agent_name =
          context.actor.user.displayName ?? context.actor.user.email;
      }
    }
  }

  let anchorResult: unknown = null;
  if (args.anchor !== undefined) {
    const threadList = await comments.listForPage(ctx, {
      pageId: page.page.id,
      status: "all",
    });
    const existing = threadList.find((entry) => entry.thread.id === thread.id);
    const updatedAnchor = await comments.updateAnchor(ctx, {
      threadId: thread.id,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
      anchor: coerceCommentAnchor(args.anchor, {
        contentHash: page.page.contentHash,
        selectedText: existing?.anchor.selectedText,
        kind: existing?.anchor.kind,
        surface: existing?.anchor.surface,
        confidence: "fuzzy",
      }),
    });
    anchorResult = updatedAnchor.data;
  }

  let reply = null;
  if (asString(args.body, "").trim()) {
    const replyInput =
      args.agent_name || args.agent_model || args.agent_session_id
        ? agentReplyInput(args, context.actor)
        : {
            threadId: thread.id,
            pageId: page.page.id,
            workspaceId: page.page.workspaceId,
            body: asString(args.body),
            authorType: "user" as const,
            authorUserId: context.actor.user?.id ?? null,
            guestName: null,
            guestSessionId: null,
            publicationId: null,
            agent: null,
          };
    const replyResult = await comments.reply(ctx, replyInput);
    reply = replyResult.data;
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.replied",
      actorUserId: context.actor.user?.id ?? null,
      payload: {
        thread_id: thread.id,
        reply_id: reply.id,
        source: "mcp",
      },
    });
  }

  let updated =
    (await comments.getThread(ctx, { threadId: thread.id })) ?? thread;
  const shouldResolve = args.resolve === true || args.status === "resolved";
  const shouldOpen = args.status === "open" || args.resolve === false;
  if (shouldResolve && updated.status !== "resolved") {
    const result = await comments.resolve(ctx, {
      threadId: thread.id,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
    });
    updated = result.data;
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.resolved",
      actorUserId: context.actor.user?.id ?? null,
      payload: { thread_id: updated.id, source: "mcp" },
    });
  } else if (shouldOpen && updated.status !== "open") {
    const result = await comments.unresolve(ctx, {
      threadId: thread.id,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
    });
    updated = result.data;
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.unresolved",
      actorUserId: context.actor.user?.id ?? null,
      payload: { thread_id: updated.id, source: "mcp" },
    });
  }

  ctx.waitUntil(search.scheduleIndexCommentThread(ctx, thread.id));
  const refreshedThread = await comments.getThread(ctx, {
    threadId: thread.id,
  });
  const refreshedThreads = await comments.listForPage(ctx, {
    pageId: page.page.id,
    status: "all",
  });
  const enriched = refreshedThreads.find(
    (entry) => entry.thread.id === thread.id,
  );
  return {
    reply,
    thread: refreshedThread ?? updated,
    replies: enriched?.replies ?? [],
    anchor: anchorResult ?? enriched?.anchor ?? null,
  };
}

export async function deleteThread(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const { thread, page } = await getThreadPage(
    context,
    asString(args.thread_id),
    "admin",
    args.workspace_id,
  );
  const deleted = await comments.deleteThread(ctx, {
    threadId: thread.id,
    pageId: page.page.id,
    workspaceId: page.page.workspaceId,
  });
  await search.removeSearchResource(ctx, {
    resourceType: "comment_thread",
    resourceId: deleted.data.id,
  });
  // Emit a review event so reviewers polling wait_for_review see the
  // deletion. Other mutation tools already emit; delete_thread was the
  // outlier. (Audit cycle 5 finding.)
  await reviewEvents.emit(ctx, {
    workspaceId: page.page.workspaceId,
    pageId: page.page.id,
    type: "comment.deleted",
    actorUserId: context.actor.user?.id ?? null,
    payload: { thread_id: deleted.data.id, source: "mcp" },
  });
  return { thread: deleted.data };
}
