import { AppError } from "./errors";
import { createId, idPrefixes } from "./ids";

export type CommentThreadStatus = "open" | "resolved";
export type CommentAuthorType = "user" | "guest" | "agent";
export type CommentAnchorKind = "text" | "point";
export type CommentAnchorSurface = "prose" | "html";
export type CommentAnchorConfidence =
  | "active"
  | "reanchored"
  | "fuzzy"
  | "manual"
  | "stale";

export type CommentAnchorSelector = {
  quote?: {
    exact: string;
    prefix: string;
    suffix: string;
  };
  position?: {
    sourceStart: number | null;
    sourceEnd: number | null;
    renderedStart?: number | null;
    renderedEnd?: number | null;
  };
  element?: {
    path: string | null;
    fingerprint?: string | null;
    tag?: string | null;
    id?: string | null;
    className?: string | null;
    role?: string | null;
    ariaLabel?: string | null;
    text?: string | null;
    alt?: string | null;
    title?: string | null;
  };
  point?: {
    x: number;
    y: number;
    coordinateSpace: "document" | "element";
    elementPath?: string | null;
  };
  documentPoint?: {
    x: number;
    y: number;
    coordinateSpace: "document";
  };
  textHit?: {
    exact: string;
    prefix: string;
    suffix: string;
    renderedStart?: number | null;
    renderedEnd?: number | null;
  };
  nearbyText?: string;
};

export type CommentAnchorInput = {
  selectedText: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  renderedDomPath?: string | null;
  prefixText: string;
  suffixText: string;
  contentHash: string;
  kind?: CommentAnchorKind;
  surface?: CommentAnchorSurface;
  selector?: CommentAnchorSelector | null;
  confidence?: CommentAnchorConfidence;
};

export type CommentThreadRecord = {
  id: string;
  pageId: string;
  workspaceId: string;
  status: CommentThreadStatus;
  selectedText: string;
  guestName: string | null;
  guestSessionId: string | null;
  publicationId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type CommentAnchorRecord = CommentAnchorInput & {
  threadId: string;
  reanchorStatus: "active" | "reanchored" | "stale";
  kind: CommentAnchorKind;
  surface: CommentAnchorSurface;
  selector: CommentAnchorSelector | null;
  confidence: CommentAnchorConfidence;
};

export type CommentReplyRecord = {
  id: string;
  threadId: string;
  body: string;
  authorType: CommentAuthorType;
  authorUserId: string | null;
  guestName: string | null;
  guestSessionId: string | null;
  publicationId: string | null;
  agentName: string | null;
  agentModel: string | null;
  agentSessionId: string | null;
  createdAt: string;
};

export type CommentThreadWithReplies = {
  thread: CommentThreadRecord;
  anchor: CommentAnchorRecord;
  replies: CommentReplyRecord[];
};

export type CreateThreadInput = {
  pageId: string;
  workspaceId: string;
  body: string;
  anchor: CommentAnchorInput;
  authorUserId?: string | null;
  guestName?: string | null;
  guestSessionId?: string | null;
  publicationId?: string | null;
};

export type ReplyInput = {
  threadId: string;
  body: string;
  authorType: CommentAuthorType;
  authorUserId?: string | null;
  guestName?: string | null;
  guestSessionId?: string | null;
  publicationId?: string | null;
  agent?: {
    name: string;
    model: string;
    sessionId: string;
  } | null;
};

export type UpdateAnchorInput = {
  threadId: string;
  anchor: CommentAnchorInput;
};

export class CommentService {
  private readonly threads = new Map<string, CommentThreadRecord>();
  private readonly anchors = new Map<string, CommentAnchorRecord>();
  private readonly replies = new Map<string, CommentReplyRecord[]>();

  createThread(input: CreateThreadInput): CommentThreadWithReplies {
    if (!input.body.trim()) {
      throw new AppError("VALIDATION_ERROR", "Comment body is required.", 400);
    }
    const normalizedAnchor = normalizeAnchorInput(input.anchor);
    if (normalizedAnchor.kind === "text" && !input.anchor.selectedText.trim()) {
      throw new AppError("VALIDATION_ERROR", "Selected text is required.", 400);
    }

    const now = new Date().toISOString();
    const threadId = createId(idPrefixes.thread);
    const replyId = createId(idPrefixes.reply);
    const thread: CommentThreadRecord = {
      id: threadId,
      pageId: input.pageId,
      workspaceId: input.workspaceId,
      status: "open",
      selectedText: normalizedAnchor.selectedText,
      guestName: input.guestName ?? null,
      guestSessionId: input.guestSessionId ?? null,
      publicationId: input.publicationId ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    const anchor: CommentAnchorRecord = {
      ...normalizedAnchor,
      threadId,
      reanchorStatus: "active",
    };
    const reply: CommentReplyRecord = {
      id: replyId,
      threadId,
      body: input.body,
      authorType: input.guestName ? "guest" : "user",
      authorUserId: input.authorUserId ?? null,
      guestName: input.guestName ?? null,
      guestSessionId: input.guestSessionId ?? null,
      publicationId: input.publicationId ?? null,
      agentName: null,
      agentModel: null,
      agentSessionId: null,
      createdAt: now,
    };

    this.threads.set(threadId, thread);
    this.anchors.set(threadId, anchor);
    this.replies.set(threadId, [reply]);
    return { thread, anchor, replies: [reply] };
  }

  reply(input: ReplyInput): CommentReplyRecord {
    const thread = this.threads.get(input.threadId);
    if (!thread) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    if (!input.body.trim()) {
      throw new AppError("VALIDATION_ERROR", "Reply body is required.", 400);
    }

    const reply: CommentReplyRecord = {
      id: createId(idPrefixes.reply),
      threadId: input.threadId,
      body: input.body,
      authorType: input.authorType,
      authorUserId: input.authorUserId ?? null,
      guestName: input.guestName ?? null,
      guestSessionId: input.guestSessionId ?? null,
      publicationId: input.publicationId ?? null,
      agentName: input.agent?.name ?? null,
      agentModel: input.agent?.model ?? null,
      agentSessionId: input.agent?.sessionId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.replies.set(input.threadId, [
      ...(this.replies.get(input.threadId) ?? []),
      reply,
    ]);
    this.threads.set(input.threadId, { ...thread, updatedAt: reply.createdAt });
    return reply;
  }

  updateAnchor(input: UpdateAnchorInput): CommentAnchorRecord {
    const thread = this.threads.get(input.threadId);
    if (!thread) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    if (thread.status !== "open") {
      throw new AppError(
        "VALIDATION_ERROR",
        "Only open comment anchors can be updated.",
        400,
      );
    }
    const current = this.anchors.get(input.threadId);
    if (!current) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment anchor was not found.",
        404,
      );
    }
    const now = new Date().toISOString();
    const anchor: CommentAnchorRecord = {
      ...current,
      ...normalizeAnchorInput(input.anchor),
      threadId: input.threadId,
      reanchorStatus:
        input.anchor.confidence === "manual"
          ? "reanchored"
          : current.reanchorStatus,
    };
    this.anchors.set(input.threadId, anchor);
    this.threads.set(input.threadId, { ...thread, updatedAt: now });
    return anchor;
  }

  resolve(threadId: string): CommentThreadRecord {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    const now = new Date().toISOString();
    const resolved = {
      ...thread,
      status: "resolved" as const,
      resolvedAt: now,
      updatedAt: now,
    };
    this.threads.set(threadId, resolved);
    return resolved;
  }

  unresolve(threadId: string): CommentThreadRecord {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    const now = new Date().toISOString();
    const unresolved = {
      ...thread,
      status: "open" as const,
      resolvedAt: null,
      updatedAt: now,
    };
    this.threads.set(threadId, unresolved);
    return unresolved;
  }

  deleteThread(threadId: string): CommentThreadRecord {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    this.threads.delete(threadId);
    this.anchors.delete(threadId);
    this.replies.delete(threadId);
    return thread;
  }

  getThread(threadId: string): CommentThreadWithReplies | null {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const anchor = this.anchors.get(threadId);
    if (!anchor) return null;
    return {
      thread,
      anchor,
      replies: this.replies.get(threadId) ?? [],
    };
  }

  listForPage(
    pageId: string,
    status: "open" | "resolved" | "all" = "open",
  ): CommentThreadWithReplies[] {
    return [...this.threads.values()]
      .filter((thread) => thread.pageId === pageId)
      .filter((thread) => status === "all" || thread.status === status)
      .map((thread) => ({
        thread,
        anchor: this.anchors.get(thread.id)!,
        replies: this.replies.get(thread.id) ?? [],
      }));
  }
}

function normalizeAnchorInput(
  input: CommentAnchorInput,
): Omit<CommentAnchorRecord, "threadId" | "reanchorStatus"> {
  const selectedText = input.selectedText.trim() || "Pinned comment";
  return {
    selectedText,
    sourceStart: input.sourceStart,
    sourceEnd: input.sourceEnd,
    renderedDomPath: input.renderedDomPath ?? null,
    prefixText: input.prefixText,
    suffixText: input.suffixText,
    contentHash: input.contentHash,
    kind: input.kind ?? "text",
    surface: input.surface ?? "prose",
    selector: input.selector ?? null,
    confidence: input.confidence ?? "active",
  };
}
