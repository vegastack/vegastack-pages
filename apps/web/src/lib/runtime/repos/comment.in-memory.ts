// In-memory CommentRepo adapter.
//
// Wraps the CommentService from packages/core. Comment counts (used by
// the shell's comments_stats badge) are derived from the thread list —
// for now, that means listing all threads and counting; the D1 adapter
// can use COUNT() for a cheaper countsForPage().

import type {
  CommentRepo,
  CommentAnchorRecord,
  CommentReplyRecord,
  CommentThreadRecord,
  CommentThreadWithReplies,
  CreateThreadInput,
  ReplyInput,
} from "@vegastack/pages-services";
import { commentService } from "../../runtime";

export function createInMemoryCommentRepo(): CommentRepo {
  return {
    async getThread(
      threadId: string,
    ): Promise<CommentThreadWithReplies | null> {
      return commentService.getThread(threadId);
    },
    async listForPage(
      pageId: string,
      status: "open" | "resolved" | "all" = "open",
    ): Promise<CommentThreadWithReplies[]> {
      return commentService.listForPage(pageId, status);
    },
    async countsForPage(pageId: string) {
      const threads = commentService.listForPage(pageId, "all");
      const open = threads.filter(
        (entry) => entry.thread.status === "open",
      ).length;
      const resolved = threads.filter(
        (entry) => entry.thread.status === "resolved",
      ).length;
      const lastActivityAt =
        threads
          .map((entry) => entry.thread.updatedAt)
          .sort()
          .pop() ?? null;
      return { open, resolved, total: threads.length, lastActivityAt };
    },
    async createThread(
      input: CreateThreadInput,
    ): Promise<CommentThreadWithReplies> {
      return commentService.createThread({
        pageId: input.pageId,
        workspaceId: input.workspaceId,
        body: input.body,
        authorUserId: input.authorUserId,
        guestName: input.guestName,
        guestSessionId: input.guestSessionId,
        publicationId: input.publicationId,
        anchor: input.anchor,
      });
    },
    async reply(input: ReplyInput): Promise<CommentReplyRecord> {
      return commentService.reply({
        threadId: input.threadId,
        body: input.body,
        authorType: input.authorType,
        authorUserId: input.authorUserId,
        guestName: input.guestName,
        guestSessionId: input.guestSessionId,
        publicationId: input.publicationId,
        agent: input.agent,
      });
    },
    async updateAnchor(input): Promise<CommentAnchorRecord> {
      return commentService.updateAnchor(input);
    },
    async resolve(threadId: string): Promise<CommentThreadRecord> {
      return commentService.resolve(threadId);
    },
    async unresolve(threadId: string): Promise<CommentThreadRecord> {
      return commentService.unresolve(threadId);
    },
    async deleteThread(threadId: string): Promise<CommentThreadRecord> {
      return commentService.deleteThread(threadId);
    },
  };
}
