// CommentRepo — threads, anchors, and replies for a page.
//
// Record types are owned by @vegastack/pages-core; this file only adds
// async signatures + the countsForPage shorthand (which the eventual
// D1 implementation runs as a cheap COUNT query).

import type {
  CommentAnchorInput,
  CommentAnchorRecord,
  CommentReplyRecord,
  CommentThreadRecord,
  CommentThreadStatus,
  CommentThreadWithReplies,
} from "@vegastack/pages-core";

export type {
  CommentAnchorInput,
  CommentAnchorRecord,
  CommentReplyRecord,
  CommentThreadRecord,
  CommentThreadStatus,
  CommentThreadWithReplies,
};

export type CreateThreadInput = {
  pageId: string;
  workspaceId: string;
  body: string;
  authorUserId: string | null;
  guestName: string | null;
  guestSessionId: string | null;
  publicationId: string | null;
  anchor: CommentAnchorInput;
};

export type ReplyInput = {
  threadId: string;
  body: string;
  authorType: "user" | "guest" | "agent";
  authorUserId: string | null;
  guestName: string | null;
  guestSessionId: string | null;
  publicationId: string | null;
  agent: { name: string; model: string; sessionId: string } | null;
};

export type CommentsStats = {
  open: number;
  resolved: number;
  total: number;
  lastActivityAt: string | null;
};

export type CommentRepo = {
  getThread(threadId: string): Promise<CommentThreadWithReplies | null>;
  listForPage(
    pageId: string,
    status?: "open" | "resolved" | "all",
  ): Promise<CommentThreadWithReplies[]>;
  // Cheap counts for the shell's comments_stats badge.
  countsForPage(pageId: string): Promise<CommentsStats>;

  createThread(input: CreateThreadInput): Promise<CommentThreadWithReplies>;
  reply(input: ReplyInput): Promise<CommentReplyRecord>;
  updateAnchor(input: {
    threadId: string;
    anchor: CommentAnchorInput;
  }): Promise<CommentAnchorRecord>;
  resolve(threadId: string): Promise<CommentThreadRecord>;
  unresolve(threadId: string): Promise<CommentThreadRecord>;
  deleteThread(threadId: string): Promise<CommentThreadRecord>;
};
