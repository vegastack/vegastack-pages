// Review events service — direct-D1 over the review_events table.
//
// Plan 011 §5. Replaces packages/core/src/review-events.ts (class-based,
// in-memory queue) with stateless functions over ServiceContext.
//
// Authorization contract: review events are an append-only audit-style
// stream. Callers (HTTP routes, MCP adapter) MUST have already verified
// the actor's workspace access before invoking emit/list. This service
// performs no authorization checks of its own.

import { d1AllRows } from "@vegastack/pages-db";
import { requireDb, type ServiceContext } from "./context.ts";

export type ReviewEventRecord = {
  id: string;
  workspaceId: string;
  pageId: string | null;
  type: string;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type EmitInput = {
  workspaceId: string;
  pageId?: string | null;
  type: string;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
};

export type ListInput = {
  workspaceId: string;
  limit?: number;
  pageId?: string | null;
  // Keyset cursor; return rows strictly older than this id.
  afterId?: string;
};

type ReviewEventRow = {
  id: string;
  workspace_id: string;
  page_id: string | null;
  type: string;
  actor_user_id: string | null;
  payload_json: string;
  created_at: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Mirror packages/core/src/ids.ts::createId, but with the "rev" prefix
// the review-events service uses for inserted rows. Inlined to avoid
// extending idPrefixes for a single call site.
function newReviewEventId(): string {
  const compact = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
  return `rev_${compact}`;
}

function rowToRecord(row: ReviewEventRow): ReviewEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // CHECK (json_valid(payload_json)) on the column guarantees this
    // never throws for rows this service wrote, but stay defensive for
    // rows written by older code paths.
    payload = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    pageId: row.page_id,
    type: row.type,
    actorUserId: row.actor_user_id,
    payload,
    createdAt: row.created_at,
  };
}

export async function emit(
  ctx: ServiceContext,
  input: EmitInput,
): Promise<ReviewEventRecord> {
  const db = requireDb(ctx);
  const id = newReviewEventId();
  const createdAt = new Date().toISOString();
  const pageId = input.pageId ?? null;
  const actorUserId = input.actorUserId ?? null;
  const payload = input.payload ?? {};
  const payloadJson = JSON.stringify(payload);

  await db
    .prepare(
      `INSERT INTO review_events
         (id, workspace_id, page_id, type, actor_user_id, payload_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      id,
      input.workspaceId,
      pageId,
      input.type,
      actorUserId,
      payloadJson,
      createdAt,
    )
    .run();

  return {
    id,
    workspaceId: input.workspaceId,
    pageId,
    type: input.type,
    actorUserId,
    payload,
    createdAt,
  };
}

export async function list(
  ctx: ServiceContext,
  input: ListInput,
): Promise<ReviewEventRecord[]> {
  const db = requireDb(ctx);
  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));

  // Multiple query shapes so each leans on a covering index:
  //   - workspace-only: review_events_workspace_created_idx
  //   - workspace + page: same idx, with page_id predicate
  //   - + afterId variants for keyset pagination
  // Newest first via created_at DESC matches the index direction.
  if (input.pageId !== undefined && input.pageId !== null && input.afterId) {
    const result = await db
      .prepare(
        `SELECT id, workspace_id, page_id, type, actor_user_id, payload_json, created_at
           FROM review_events
          WHERE workspace_id = ?1 AND page_id = ?2
            AND created_at < (SELECT created_at FROM review_events WHERE id = ?3)
          ORDER BY created_at DESC
          LIMIT ?4`,
      )
      .bind(input.workspaceId, input.pageId, input.afterId, limit)
      .all<ReviewEventRow>();
    return d1AllRows(result).map(rowToRecord);
  }
  if (input.pageId !== undefined && input.pageId !== null) {
    const result = await db
      .prepare(
        `SELECT id, workspace_id, page_id, type, actor_user_id, payload_json, created_at
           FROM review_events
          WHERE workspace_id = ?1 AND page_id = ?2
          ORDER BY created_at DESC
          LIMIT ?3`,
      )
      .bind(input.workspaceId, input.pageId, limit)
      .all<ReviewEventRow>();
    return d1AllRows(result).map(rowToRecord);
  }
  if (input.afterId) {
    const result = await db
      .prepare(
        `SELECT id, workspace_id, page_id, type, actor_user_id, payload_json, created_at
           FROM review_events
          WHERE workspace_id = ?1
            AND created_at < (SELECT created_at FROM review_events WHERE id = ?2)
          ORDER BY created_at DESC
          LIMIT ?3`,
      )
      .bind(input.workspaceId, input.afterId, limit)
      .all<ReviewEventRow>();
    return d1AllRows(result).map(rowToRecord);
  }

  const result = await db
    .prepare(
      `SELECT id, workspace_id, page_id, type, actor_user_id, payload_json, created_at
         FROM review_events
        WHERE workspace_id = ?1
        ORDER BY created_at DESC
        LIMIT ?2`,
    )
    .bind(input.workspaceId, limit)
    .all<ReviewEventRow>();
  return d1AllRows(result).map(rowToRecord);
}
