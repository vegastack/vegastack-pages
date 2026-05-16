// CommentsService — application logic for comment threads, anchors,
// and replies.

import type { ServiceContext, MutationEnvelope } from "./context.ts";
import type {
  CommentAnchorInput,
  CommentReplyRecord,
  CommentThreadRecord,
  CommentThreadWithReplies,
  CommentsStats,
  CreateThreadInput,
  ReplyInput,
} from "./repo/comment.repo.ts";
import { buildEnvelope } from "./envelope.ts";

export type CommentMutationResult<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

export async function listForPage(
  ctx: ServiceContext,
  input: { pageId: string; status?: "open" | "resolved" | "all" },
): Promise<CommentThreadWithReplies[]> {
  return ctx.repo.comments.listForPage(input.pageId, input.status);
}

export async function countsForPage(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<CommentsStats> {
  return ctx.repo.comments.countsForPage(input.pageId);
}

export async function createThread(
  ctx: ServiceContext,
  input: CreateThreadInput,
): Promise<CommentMutationResult<CommentThreadWithReplies>> {
  const created = await ctx.repo.comments.createThread({
    pageId: input.pageId,
    workspaceId: input.workspaceId,
    body: input.body,
    authorUserId: input.authorUserId,
    guestName: input.guestName,
    guestSessionId: input.guestSessionId,
    publicationId: input.publicationId,
    anchor: input.anchor,
  });
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: created,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `comments_stats:${input.pageId}`,
        `thread:${created.thread.id}`,
      ],
    }),
  };
}

export async function reply(
  ctx: ServiceContext,
  input: ReplyInput & { pageId: string; workspaceId: string },
): Promise<CommentMutationResult<CommentReplyRecord>> {
  const created = await ctx.repo.comments.reply({
    threadId: input.threadId,
    body: input.body,
    authorType: input.authorType,
    authorUserId: input.authorUserId,
    guestName: input.guestName,
    guestSessionId: input.guestSessionId,
    publicationId: input.publicationId,
    agent: input.agent,
  });
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: created,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `comments_stats:${input.pageId}`,
        `thread:${input.threadId}`,
      ],
    }),
  };
}

export async function resolve(
  ctx: ServiceContext,
  input: { threadId: string; pageId: string; workspaceId: string },
): Promise<CommentMutationResult<CommentThreadRecord>> {
  const resolved = await ctx.repo.comments.resolve(input.threadId);
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: resolved,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `comments_stats:${input.pageId}`,
        `thread:${input.threadId}`,
      ],
    }),
  };
}

export async function unresolve(
  ctx: ServiceContext,
  input: { threadId: string; pageId: string; workspaceId: string },
): Promise<CommentMutationResult<CommentThreadRecord>> {
  const result = await ctx.repo.comments.unresolve(input.threadId);
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: result,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `comments_stats:${input.pageId}`,
        `thread:${input.threadId}`,
      ],
    }),
  };
}

export async function updateAnchor(
  ctx: ServiceContext,
  input: {
    threadId: string;
    anchor: CommentAnchorInput;
    pageId: string;
    workspaceId: string;
  },
): Promise<
  CommentMutationResult<
    Awaited<ReturnType<typeof ctx.repo.comments.updateAnchor>>
  >
> {
  const updated = await ctx.repo.comments.updateAnchor({
    threadId: input.threadId,
    anchor: input.anchor,
  });
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: updated,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [`thread:${input.threadId}`],
    }),
  };
}

export async function deleteThread(
  ctx: ServiceContext,
  input: { threadId: string; pageId: string; workspaceId: string },
): Promise<CommentMutationResult<CommentThreadRecord>> {
  const deleted = await ctx.repo.comments.deleteThread(input.threadId);
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: deleted,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `comments_stats:${input.pageId}`,
        `thread:${input.threadId}`,
      ],
    }),
  };
}
