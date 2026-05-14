import type {
  CommentReplyRecord,
  CommentThreadWithReplies,
} from "@vegastack/pages-core";
import { workspaceService } from "./runtime";

export type EnrichedReply = CommentReplyRecord & {
  authorDisplayName: string | null;
};

export type EnrichedThread = Omit<CommentThreadWithReplies, "replies"> & {
  replies: EnrichedReply[];
};

const NAME_CACHE = new Map<string, string | null>();

function lookupDisplayName(userId: string | null): string | null {
  if (!userId) return null;
  if (NAME_CACHE.has(userId)) return NAME_CACHE.get(userId) ?? null;
  const user = workspaceService.getUser(userId);
  const name = user?.displayName?.trim() || user?.email || null;
  NAME_CACHE.set(userId, name);
  return name;
}

export function enrichReply(reply: CommentReplyRecord): EnrichedReply {
  return {
    ...reply,
    authorDisplayName: lookupDisplayName(reply.authorUserId ?? null),
  };
}

export function enrichThread(thread: CommentThreadWithReplies): EnrichedThread {
  return {
    ...thread,
    replies: thread.replies.map(enrichReply),
  };
}

export function enrichThreads(
  threads: CommentThreadWithReplies[],
): EnrichedThread[] {
  return threads.map(enrichThread);
}
