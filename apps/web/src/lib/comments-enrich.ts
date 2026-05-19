// Enrich comment threads with author display names. The thread/reply
// rows store `author_user_id` only; this helper joins against the
// users table (via D1).
//
// We deliberately do NOT cache user records across requests. The
// previous process-lifetime cache served stale display names forever
// after a user updated their profile (audit cycle 5 finding). D1 reads
// for these lookups are batched via Promise.all inside enrichThreads,
// and a single isolate typically resolves the same user once per
// request anyway — the marginal saving wasn't worth the staleness.

import type {
  CommentReplyRecord,
  CommentThreadWithReplies,
} from "@vegastack/pages-core";
import { users } from "@vegastack/pages-services";
import { getDb } from "./runtime";

export type EnrichedReply = CommentReplyRecord & {
  authorDisplayName: string | null;
};

export type EnrichedThread = Omit<CommentThreadWithReplies, "replies"> & {
  replies: EnrichedReply[];
};

async function lookupDisplayName(
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const db = await getDb();
  if (!db) return null;
  const user = await users.getById(
    {
      actor: { userId: "", email: null, workspaceId: null },
      db,
      async computeTreeVersion() {
        return "";
      },
      waitUntil(p) {
        void p.catch(() => undefined);
      },
      log() {},
    },
    userId,
  );
  return user?.displayName?.trim() || user?.email || null;
}

export async function enrichReply(
  reply: CommentReplyRecord,
): Promise<EnrichedReply> {
  return {
    ...reply,
    authorDisplayName: await lookupDisplayName(reply.authorUserId ?? null),
  };
}

export async function enrichThread(
  thread: CommentThreadWithReplies,
): Promise<EnrichedThread> {
  return {
    ...thread,
    replies: await Promise.all(thread.replies.map(enrichReply)),
  };
}

export async function enrichThreads(
  threads: CommentThreadWithReplies[],
): Promise<EnrichedThread[]> {
  return Promise.all(threads.map(enrichThread));
}
