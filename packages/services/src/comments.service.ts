// Comments service — direct-D1 reads/writes against comment_threads,
// comment_anchors, and comment_replies.
//
// Plan 011 §5 phase 10. Replaces the prior repo-backed implementation
// (ctx.repo.comments → in-memory CommentService) with plain async
// functions over ServiceContext.db. Public function signatures and the
// CommentMutationResult return shape are preserved EXACTLY so existing
// callers (apps/web routes + MCP adapter) keep working without edits.
//
// Authorization contract: routes/MCP MUST verify that the actor has
// `comment` access to the page BEFORE invoking createThread/reply/
// updateAnchor and `write` access for resolve/unresolve/deleteThread.
// This service performs no per-resource authorization; it only checks
// AUTHENTICATION (actor.userId present) for non-guest paths.
//
// Concurrency: createThread INSERTs the thread + anchor in a single
// db.batch([...]) so the two rows either both land or both roll back.
// comment_anchors uses thread_id as PRIMARY KEY (1:1 with threads) and
// FK CASCADEs from comment_threads → both anchors and replies disappear
// when a thread row is deleted.
//
// Legacy notes:
//   - `comment_anchors.selector_json` is nullable + json_valid; we
//     stringify the selector object on writes and JSON.parse on reads.
//   - CommentAnchorRecord still exposes `reanchorStatus` (derived from
//     `confidence`) so downstream code that reads it doesn't break.

import { createId, idPrefixes } from "@vegastack/pages-core";
import type {
  CommentAnchorConfidence,
  CommentAnchorInput,
  CommentAnchorKind,
  CommentAnchorRecord,
  CommentAnchorSelector,
  CommentAnchorSurface,
  CommentAuthorType,
  CommentReplyRecord,
  CommentThreadRecord,
  CommentThreadStatus,
  CommentThreadWithReplies,
} from "@vegastack/pages-core";
import {
  d1AllRows,
  type D1Database,
  type D1PreparedStatement,
} from "@vegastack/pages-db";
import {
  requireDb,
  type ServiceContext,
  type MutationEnvelope,
} from "./context.ts";
import { buildEnvelope } from "./envelope.ts";
import { ServiceError } from "./errors.ts";
import type {
  CommentsStats,
  CreateThreadInput,
  ReplyInput,
} from "./repo/comment.repo.ts";

// Re-export the input/record types the prior service surfaced so existing
// callers (apps/web routes, MCP) can keep importing them from this file
// transitively via @vegastack/pages-services.
export type {
  CommentAnchorInput,
  CommentAnchorRecord,
  CommentReplyRecord,
  CommentThreadRecord,
  CommentThreadStatus,
  CommentThreadWithReplies,
  CommentsStats,
  CreateThreadInput,
  ReplyInput,
};

export type CommentMutationResult<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

// ---------------------------------------------------------------------------
// Row shapes (snake_case as they live in SQLite/D1)
// ---------------------------------------------------------------------------

type ThreadRow = {
  id: string;
  page_id: string;
  workspace_id: string;
  status: string;
  selected_text: string;
  guest_name: string | null;
  guest_session_id: string | null;
  publication_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

type AnchorRow = {
  thread_id: string;
  source_start: number | null;
  source_end: number | null;
  rendered_dom_path: string | null;
  selected_text: string;
  prefix_text: string;
  suffix_text: string;
  content_hash_at_creation: string;
  anchor_kind: string;
  surface: string;
  selector_json: string | null;
  confidence: string;
};

type ReplyRow = {
  id: string;
  thread_id: string;
  body: string;
  author_type: string;
  author_user_id: string | null;
  guest_name: string | null;
  guest_session_id: string | null;
  publication_id: string | null;
  agent_name: string | null;
  agent_model: string | null;
  agent_session_id: string | null;
  created_at: string;
};

const THREAD_COLUMNS =
  "id, page_id, workspace_id, status, selected_text, guest_name, guest_session_id, publication_id, resolved_at, created_at, updated_at";
const ANCHOR_COLUMNS =
  "thread_id, source_start, source_end, rendered_dom_path, selected_text, prefix_text, suffix_text, content_hash_at_creation, anchor_kind, surface, selector_json, confidence";
const REPLY_COLUMNS =
  "id, thread_id, body, author_type, author_user_id, guest_name, guest_session_id, publication_id, agent_name, agent_model, agent_session_id, created_at";

// db.batch is optional on the D1Database interface (the minimal node
// adapter omits it in some builds). Fall back to sequential statements
// when missing; the call sites that use this helper are at most three
// statements each, so the loss of atomicity is the only trade-off, and
// our actual runtime targets (Cloudflare D1 + node:sqlite test adapter)
// both implement batch.
async function runBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const stmt of statements) {
    await stmt.run();
  }
}

// ---------------------------------------------------------------------------
// Row → record mappers
// ---------------------------------------------------------------------------

function normalizeStatus(value: string): CommentThreadStatus {
  // Schema CHECK guarantees one of 'open' | 'resolved'.
  return value === "resolved" ? "resolved" : "open";
}

function normalizeKind(value: string | null | undefined): CommentAnchorKind {
  return value === "point" ? "point" : "text";
}

function normalizeSurface(
  value: string | null | undefined,
): CommentAnchorSurface {
  return value === "html" ? "html" : "prose";
}

function normalizeConfidence(value: string): CommentAnchorConfidence {
  switch (value) {
    case "reanchored":
    case "fuzzy":
    case "manual":
    case "stale":
      return value;
    default:
      return "active";
  }
}

function normalizeAuthorType(value: string): CommentAuthorType {
  switch (value) {
    case "guest":
    case "agent":
      return value;
    default:
      return "user";
  }
}

// Translate the `confidence` enum onto the legacy reanchorStatus tri-state
// the CommentAnchorRecord shape still exposes. "active" stays active,
// "stale" stays stale, everything else collapses to "reanchored".
function confidenceToReanchorStatus(
  confidence: CommentAnchorConfidence,
): CommentAnchorRecord["reanchorStatus"] {
  if (confidence === "active") return "active";
  if (confidence === "stale") return "stale";
  return "reanchored";
}

function parseSelector(json: string | null): CommentAnchorSelector | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CommentAnchorSelector;
    }
    return null;
  } catch {
    // CHECK (selector_json IS NULL OR json_valid(...)) makes this
    // unreachable for rows written by this service; stay defensive.
    return null;
  }
}

function threadRowToRecord(row: ThreadRow): CommentThreadRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    workspaceId: row.workspace_id,
    status: normalizeStatus(row.status),
    selectedText: row.selected_text,
    guestName: row.guest_name,
    guestSessionId: row.guest_session_id,
    publicationId: row.publication_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function anchorRowToRecord(row: AnchorRow): CommentAnchorRecord {
  const confidence = normalizeConfidence(row.confidence);
  return {
    threadId: row.thread_id,
    selectedText: row.selected_text,
    sourceStart: row.source_start,
    sourceEnd: row.source_end,
    renderedDomPath: row.rendered_dom_path,
    prefixText: row.prefix_text,
    suffixText: row.suffix_text,
    contentHash: row.content_hash_at_creation,
    kind: normalizeKind(row.anchor_kind),
    surface: normalizeSurface(row.surface),
    selector: parseSelector(row.selector_json),
    confidence,
    reanchorStatus: confidenceToReanchorStatus(confidence),
  };
}

function replyRowToRecord(row: ReplyRow): CommentReplyRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    body: row.body,
    authorType: normalizeAuthorType(row.author_type),
    authorUserId: row.author_user_id,
    guestName: row.guest_name,
    guestSessionId: row.guest_session_id,
    publicationId: row.publication_id,
    agentName: row.agent_name,
    agentModel: row.agent_model,
    agentSessionId: row.agent_session_id,
    createdAt: row.created_at,
  };
}

// Normalize the caller-supplied anchor input the same way the legacy
// CommentService did: trim selectedText (with a placeholder fallback so
// the column's NOT NULL constraint never fires for pinned anchors), and
// default optional fields.
type NormalizedAnchor = {
  selectedText: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  renderedDomPath: string | null;
  prefixText: string;
  suffixText: string;
  contentHash: string;
  kind: CommentAnchorKind;
  surface: CommentAnchorSurface;
  selector: CommentAnchorSelector | null;
  confidence: CommentAnchorConfidence;
};

function normalizeAnchorInput(input: CommentAnchorInput): NormalizedAnchor {
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

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

async function fetchReplies(
  ctx: ServiceContext,
  threadIds: string[],
): Promise<Map<string, CommentReplyRecord[]>> {
  const grouped = new Map<string, CommentReplyRecord[]>();
  if (threadIds.length === 0) return grouped;
  const db = requireDb(ctx);
  // SQLite parameter binding doesn't support array spreads in IN(), so
  // build the placeholder list explicitly. threadIds is bounded by the
  // caller's page-level thread count (typically dozens, not thousands).
  const placeholders = threadIds.map((_, idx) => `?${idx + 1}`).join(", ");
  const result = await db
    .prepare(
      `SELECT ${REPLY_COLUMNS}
         FROM comment_replies
        WHERE thread_id IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(...threadIds)
    .all<ReplyRow>();
  for (const row of d1AllRows(result)) {
    const record = replyRowToRecord(row);
    const list = grouped.get(record.threadId);
    if (list) list.push(record);
    else grouped.set(record.threadId, [record]);
  }
  return grouped;
}

async function fetchAnchors(
  ctx: ServiceContext,
  threadIds: string[],
): Promise<Map<string, CommentAnchorRecord>> {
  const grouped = new Map<string, CommentAnchorRecord>();
  if (threadIds.length === 0) return grouped;
  const db = requireDb(ctx);
  const placeholders = threadIds.map((_, idx) => `?${idx + 1}`).join(", ");
  const result = await db
    .prepare(
      `SELECT ${ANCHOR_COLUMNS}
         FROM comment_anchors
        WHERE thread_id IN (${placeholders})`,
    )
    .bind(...threadIds)
    .all<AnchorRow>();
  for (const row of d1AllRows(result)) {
    const record = anchorRowToRecord(row);
    grouped.set(record.threadId, record);
  }
  return grouped;
}

async function requireThreadRow(
  ctx: ServiceContext,
  threadId: string,
): Promise<ThreadRow> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${THREAD_COLUMNS} FROM comment_threads WHERE id = ?1`)
    .bind(threadId)
    .first<ThreadRow>();
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Comment thread was not found.");
  }
  return row;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getThread(
  ctx: ServiceContext,
  input: { threadId: string },
): Promise<CommentThreadRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${THREAD_COLUMNS} FROM comment_threads WHERE id = ?1`)
    .bind(input.threadId)
    .first<ThreadRow>();
  return row ? threadRowToRecord(row) : null;
}

export async function listForPage(
  ctx: ServiceContext,
  input: { pageId: string; status?: "open" | "resolved" | "all" },
): Promise<CommentThreadWithReplies[]> {
  const db = requireDb(ctx);
  const status = input.status ?? "open";

  // Index: comment_threads_page_status_created_idx (page_id, status,
  // created_at DESC). Status branch keeps the SARGable predicate that
  // matches the index leading columns.
  const result =
    status === "all"
      ? await db
          .prepare(
            `SELECT ${THREAD_COLUMNS}
               FROM comment_threads
              WHERE page_id = ?1
              ORDER BY created_at DESC, id ASC`,
          )
          .bind(input.pageId)
          .all<ThreadRow>()
      : await db
          .prepare(
            `SELECT ${THREAD_COLUMNS}
               FROM comment_threads
              WHERE page_id = ?1 AND status = ?2
              ORDER BY created_at DESC, id ASC`,
          )
          .bind(input.pageId, status)
          .all<ThreadRow>();

  const threadRows = d1AllRows(result);
  if (threadRows.length === 0) return [];

  const threadIds = threadRows.map((row) => row.id);
  const [anchors, replies] = await Promise.all([
    fetchAnchors(ctx, threadIds),
    fetchReplies(ctx, threadIds),
  ]);

  const out: CommentThreadWithReplies[] = [];
  for (const row of threadRows) {
    const anchor = anchors.get(row.id);
    if (!anchor) continue; // thread without anchor: skip defensively
    out.push({
      thread: threadRowToRecord(row),
      anchor,
      replies: replies.get(row.id) ?? [],
    });
  }
  return out;
}

export async function countsForPage(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<CommentsStats> {
  const db = requireDb(ctx);
  // Single round-trip: aggregate with conditional SUM(). Cheaper than
  // listing rows and counting in JS, matches the badge usage on the
  // shell's page header.
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
         MAX(updated_at) AS last_activity_at
       FROM comment_threads
       WHERE page_id = ?1`,
    )
    .bind(input.pageId)
    .first<{
      total: number | null;
      open_count: number | null;
      resolved_count: number | null;
      last_activity_at: string | null;
    }>();
  return {
    open: Number(row?.open_count ?? 0),
    resolved: Number(row?.resolved_count ?? 0),
    total: Number(row?.total ?? 0),
    lastActivityAt: row?.last_activity_at ?? null,
  };
}

export async function createThread(
  ctx: ServiceContext,
  input: CreateThreadInput,
): Promise<CommentMutationResult<CommentThreadWithReplies>> {
  if (!input.body.trim()) {
    throw new ServiceError("VALIDATION", "Comment body is required.");
  }
  const anchor = normalizeAnchorInput(input.anchor);
  if (anchor.kind === "text" && !input.anchor.selectedText.trim()) {
    throw new ServiceError("VALIDATION", "Selected text is required.");
  }
  // Non-guest paths require an authenticated actor. Guest comments
  // arrive via the publication path and carry guestName/guestSessionId
  // instead of authorUserId.
  const isGuest = Boolean(input.guestName || input.guestSessionId);
  if (!isGuest && !input.authorUserId && !ctx.actor.userId) {
    throw new ServiceError(
      "UNAUTHORIZED",
      "Sign in is required to create a comment.",
    );
  }

  const db = requireDb(ctx);
  const now = new Date().toISOString();
  const threadId = createId(idPrefixes.thread);
  const replyId = createId(idPrefixes.reply);
  const selectorJson = anchor.selector ? JSON.stringify(anchor.selector) : null;
  const authorType: CommentAuthorType = input.guestName ? "guest" : "user";

  // Single batched transaction: thread + anchor + opening reply land
  // atomically. If any statement fails the whole batch rolls back, so
  // we never end up with a thread row without an anchor or an opening
  // reply.
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO comment_threads
           (id, page_id, workspace_id, status, selected_text,
            guest_name, guest_session_id, publication_id,
            resolved_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, NULL, ?8, ?8)`,
      )
      .bind(
        threadId,
        input.pageId,
        input.workspaceId,
        anchor.selectedText,
        input.guestName ?? null,
        input.guestSessionId ?? null,
        input.publicationId ?? null,
        now,
      ),
    db
      .prepare(
        `INSERT INTO comment_anchors
           (thread_id, source_start, source_end, rendered_dom_path,
            selected_text, prefix_text, suffix_text,
            content_hash_at_creation, anchor_kind, surface,
            selector_json, confidence)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        threadId,
        anchor.sourceStart,
        anchor.sourceEnd,
        anchor.renderedDomPath,
        anchor.selectedText,
        anchor.prefixText,
        anchor.suffixText,
        anchor.contentHash,
        anchor.kind,
        anchor.surface,
        selectorJson,
        anchor.confidence,
      ),
    db
      .prepare(
        `INSERT INTO comment_replies
           (id, thread_id, body, author_type, author_user_id,
            guest_name, guest_session_id, publication_id,
            agent_name, agent_model, agent_session_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, ?9)`,
      )
      .bind(
        replyId,
        threadId,
        input.body,
        authorType,
        input.authorUserId ?? null,
        input.guestName ?? null,
        input.guestSessionId ?? null,
        input.publicationId ?? null,
        now,
      ),
  ]);

  const created: CommentThreadWithReplies = {
    thread: {
      id: threadId,
      pageId: input.pageId,
      workspaceId: input.workspaceId,
      status: "open",
      selectedText: anchor.selectedText,
      guestName: input.guestName ?? null,
      guestSessionId: input.guestSessionId ?? null,
      publicationId: input.publicationId ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    },
    anchor: {
      threadId,
      selectedText: anchor.selectedText,
      sourceStart: anchor.sourceStart,
      sourceEnd: anchor.sourceEnd,
      renderedDomPath: anchor.renderedDomPath,
      prefixText: anchor.prefixText,
      suffixText: anchor.suffixText,
      contentHash: anchor.contentHash,
      kind: anchor.kind,
      surface: anchor.surface,
      selector: anchor.selector,
      confidence: anchor.confidence,
      reanchorStatus: confidenceToReanchorStatus(anchor.confidence),
    },
    replies: [
      {
        id: replyId,
        threadId,
        body: input.body,
        authorType,
        authorUserId: input.authorUserId ?? null,
        guestName: input.guestName ?? null,
        guestSessionId: input.guestSessionId ?? null,
        publicationId: input.publicationId ?? null,
        agentName: null,
        agentModel: null,
        agentSessionId: null,
        createdAt: now,
      },
    ],
  };

  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: created,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `comments_stats:${input.pageId}`,
        `thread:${threadId}`,
      ],
    }),
  };
}

export async function reply(
  ctx: ServiceContext,
  input: ReplyInput & { pageId: string; workspaceId: string },
): Promise<CommentMutationResult<CommentReplyRecord>> {
  if (!input.body.trim()) {
    throw new ServiceError("VALIDATION", "Reply body is required.");
  }
  // Guests pass guestSessionId; agents arrive with input.agent populated.
  // Real users must have an authenticated actor.
  if (input.authorType === "user" && !input.authorUserId && !ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in is required to reply.");
  }

  // Existence check up front so we throw NOT_FOUND BEFORE inserting an
  // orphan row would have failed on the FK anyway. Friendlier error
  // shape for the caller.
  await requireThreadRow(ctx, input.threadId);

  const db = requireDb(ctx);
  const id = createId(idPrefixes.reply);
  const now = new Date().toISOString();

  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO comment_replies
           (id, thread_id, body, author_type, author_user_id,
            guest_name, guest_session_id, publication_id,
            agent_name, agent_model, agent_session_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        id,
        input.threadId,
        input.body,
        input.authorType,
        input.authorUserId ?? null,
        input.guestName ?? null,
        input.guestSessionId ?? null,
        input.publicationId ?? null,
        input.agent?.name ?? null,
        input.agent?.model ?? null,
        input.agent?.sessionId ?? null,
        now,
      ),
    // Bump the thread's updated_at so listForPage/countsForPage's
    // last_activity_at reflects the new reply without a separate read.
    db
      .prepare(`UPDATE comment_threads SET updated_at = ?2 WHERE id = ?1`)
      .bind(input.threadId, now),
  ]);

  const created: CommentReplyRecord = {
    id,
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
    createdAt: now,
  };

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
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE comment_threads
          SET status = 'resolved',
              resolved_at = ?2,
              updated_at = ?2
        WHERE id = ?1
        RETURNING ${THREAD_COLUMNS}`,
    )
    .bind(input.threadId, now)
    .first<ThreadRow>();
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Comment thread was not found.");
  }
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: threadRowToRecord(row),
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
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE comment_threads
          SET status = 'open',
              resolved_at = NULL,
              updated_at = ?2
        WHERE id = ?1
        RETURNING ${THREAD_COLUMNS}`,
    )
    .bind(input.threadId, now)
    .first<ThreadRow>();
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Comment thread was not found.");
  }
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: threadRowToRecord(row),
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
): Promise<CommentMutationResult<CommentAnchorRecord>> {
  const thread = await requireThreadRow(ctx, input.threadId);
  if (normalizeStatus(thread.status) !== "open") {
    throw new ServiceError(
      "VALIDATION",
      "Only open comment anchors can be updated.",
    );
  }
  const anchor = normalizeAnchorInput(input.anchor);
  const selectorJson = anchor.selector ? JSON.stringify(anchor.selector) : null;

  const db = requireDb(ctx);
  const now = new Date().toISOString();

  await runBatch(db, [
    db
      .prepare(
        `UPDATE comment_anchors
            SET source_start = ?2,
                source_end = ?3,
                rendered_dom_path = ?4,
                selected_text = ?5,
                prefix_text = ?6,
                suffix_text = ?7,
                content_hash_at_creation = ?8,
                anchor_kind = ?9,
                surface = ?10,
                selector_json = ?11,
                confidence = ?12
          WHERE thread_id = ?1`,
      )
      .bind(
        input.threadId,
        anchor.sourceStart,
        anchor.sourceEnd,
        anchor.renderedDomPath,
        anchor.selectedText,
        anchor.prefixText,
        anchor.suffixText,
        anchor.contentHash,
        anchor.kind,
        anchor.surface,
        selectorJson,
        anchor.confidence,
      ),
    db
      .prepare(`UPDATE comment_threads SET updated_at = ?2 WHERE id = ?1`)
      .bind(input.threadId, now),
  ]);

  const updated: CommentAnchorRecord = {
    threadId: input.threadId,
    selectedText: anchor.selectedText,
    sourceStart: anchor.sourceStart,
    sourceEnd: anchor.sourceEnd,
    renderedDomPath: anchor.renderedDomPath,
    prefixText: anchor.prefixText,
    suffixText: anchor.suffixText,
    contentHash: anchor.contentHash,
    kind: anchor.kind,
    surface: anchor.surface,
    selector: anchor.selector,
    confidence: anchor.confidence,
    reanchorStatus: confidenceToReanchorStatus(anchor.confidence),
  };

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
  // RETURNING gives us the deleted row in one round-trip. FK CASCADE
  // from comment_threads → comment_anchors + comment_replies cleans up
  // the dependent rows atomically.
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `DELETE FROM comment_threads
        WHERE id = ?1
        RETURNING ${THREAD_COLUMNS}`,
    )
    .bind(input.threadId)
    .first<ThreadRow>();
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Comment thread was not found.");
  }
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: threadRowToRecord(row),
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
