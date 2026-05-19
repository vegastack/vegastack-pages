// FavoritesService — application logic for sidebar pinning.
//
// Plan 011 §5 phase 7. Migrated from the legacy in-memory repo
// (ctx.repo.favorites) to direct-D1 (ctx.db). The page lookup that
// resolves the workspace id also moves off ctx.repo.pages to a direct
// SELECT against the `pages` table.
//
// Every operation that mutates state produces a MutationEnvelope built
// with the POST-mutation `tree_version` (computed via
// `ctx.computeTreeVersion(workspaceId)`) so clients comparing the
// envelope against their cached tree always see the latest version.
//
// Authorization contract: routes/MCP MUST verify the actor has at
// least read access to the page BEFORE calling add/remove. This service
// only checks that the caller is authenticated (ctx.actor.userId) and
// that the page row exists.

import type { FavoriteRecord } from "@vegastack/pages-core";
import { buildEnvelope } from "./envelope.ts";
import {
  requireDb,
  type MutationEnvelope,
  type ServiceContext,
} from "./context.ts";
import { ServiceError } from "./errors.ts";

export type { FavoriteRecord };

export type FavoriteResult = {
  favorite: FavoriteRecord | null;
  envelope: MutationEnvelope;
};

type PageRow = {
  id: string;
  workspace_id: string;
};

type FavoriteRow = {
  user_id: string;
  workspace_id: string;
  page_id: string;
  created_at: string;
};

function rowToRecord(row: FavoriteRow): FavoriteRecord {
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    pageId: row.page_id,
    createdAt: row.created_at,
  };
}

async function lookupPage(
  db: NonNullable<ServiceContext["db"]>,
  pageId: string,
): Promise<PageRow> {
  const row = await db
    .prepare(
      "SELECT id, workspace_id FROM pages WHERE id = ?1 AND deleted_at IS NULL",
    )
    .bind(pageId)
    .first<PageRow>();
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  return row;
}

export async function add(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<FavoriteResult> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in to manage favorites.");
  }
  const db = requireDb(ctx);
  const page = await lookupPage(db, input.pageId);
  const userId = ctx.actor.userId;

  // INSERT OR IGNORE keeps the operation idempotent: a second add() with
  // the same (user_id, page_id) PK keeps the original created_at so the
  // existing row's timestamp is the authoritative pin time. We then read
  // the row back so callers always receive the canonical record.
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO page_favorites
         (user_id, workspace_id, page_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(userId, page.workspace_id, page.id, now)
    .run();

  const stored = await db
    .prepare(
      `SELECT user_id, workspace_id, page_id, created_at
         FROM page_favorites
        WHERE user_id = ?1 AND page_id = ?2`,
    )
    .bind(userId, page.id)
    .first<FavoriteRow>();
  // Should always be present after the insert; surface as INTERNAL if
  // some other writer concurrently deleted it between INSERT and SELECT.
  if (!stored) {
    throw new ServiceError(
      "INTERNAL",
      "Failed to persist favorite — row disappeared after insert.",
    );
  }

  // Compute tree_version AFTER the mutation so the envelope reflects
  // the new pinned state visible in the sidebar.
  const treeVersion = await ctx.computeTreeVersion(page.workspace_id);
  return {
    favorite: rowToRecord(stored),
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`favorite:${page.id}:${userId}`, `page:${page.id}`],
    }),
  };
}

export async function remove(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<FavoriteResult> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in to manage favorites.");
  }
  const db = requireDb(ctx);
  const page = await lookupPage(db, input.pageId);
  const userId = ctx.actor.userId;

  // DELETE is naturally idempotent — a missing row is a no-op.
  await db
    .prepare("DELETE FROM page_favorites WHERE user_id = ?1 AND page_id = ?2")
    .bind(userId, page.id)
    .run();

  const treeVersion = await ctx.computeTreeVersion(page.workspace_id);
  return {
    favorite: null,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`favorite:${page.id}:${userId}`, `page:${page.id}`],
    }),
  };
}

export async function listForWorkspace(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<FavoriteRecord[]> {
  if (!ctx.actor.userId) return [];
  const db = requireDb(ctx);
  // Index: page_favorites_user_workspace_idx (user_id, workspace_id,
  // created_at DESC). The JOIN against `pages` filters out
  // soft-deleted pages so the sidebar never renders dangling pins.
  const result = await db
    .prepare(
      `SELECT f.user_id, f.workspace_id, f.page_id, f.created_at
         FROM page_favorites AS f
         JOIN pages AS p
           ON p.id = f.page_id
          AND p.deleted_at IS NULL
        WHERE f.user_id = ?1
          AND f.workspace_id = ?2
        ORDER BY f.created_at DESC, f.page_id ASC`,
    )
    .bind(ctx.actor.userId, input.workspaceId)
    .all<FavoriteRow>();
  const rows: FavoriteRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);
  return rows.map(rowToRecord);
}
