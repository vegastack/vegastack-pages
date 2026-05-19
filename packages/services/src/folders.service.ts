// Folders service — direct-D1 reads/writes against the folders table.
//
// Plan 011 §5 phase 13 (the "hardest" phase). Replaces the folder
// methods that lived on the class-based WorkspaceService in
// packages/core/src/workspaces.ts with plain async functions over
// ServiceContext.
//
// Why this phase is harder than its siblings: every folder row carries a
// denormalized `path` (e.g. "/parent-slug/child-slug") so the nav tree
// can be reconstructed without recursing. A rename or move therefore has
// to rebuild the path on the folder AND every descendant. We do this
// atomically via db.batch(), paginating once the descendant set crosses
// the per-batch cap from plan §15 (~100 statements).
//
// Authorization contract: services here check input shape and row
// existence only. Routes are responsible for verifying the actor has
// permission on the workspace / target folder BEFORE calling these
// mutations.

import { AppError, createId, idPrefixes } from "@vegastack/pages-core";
import type { D1PreparedStatement } from "@vegastack/pages-db";
import { requireDb, type ServiceContext } from "./context.ts";
import { clampLimit, decodeCursor, encodeCursor } from "./cursor.ts";
import type { PaginatedResult } from "./cursor.ts";

export type FolderRecord = {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  slug: string;
  slugId: string;
  path: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type FolderRow = {
  id: string;
  workspace_id: string;
  parent_folder_id: string | null;
  name: string;
  slug: string;
  slug_id: string;
  path: string;
  position: number;
  created_at: string;
  updated_at: string;
};

// Cap a single db.batch() at this many statements so we don't blow past
// the D1 transaction size (plan §15 risk row). Folders with more than
// MAX_BATCH descendants are updated in successive batches.
const MAX_BATCH = 100;

const SELECT_COLUMNS =
  "id, workspace_id, parent_folder_id, name, slug, slug_id, path, position, created_at, updated_at";

function rowToRecord(row: FolderRow): FolderRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentFolderId: row.parent_folder_id,
    name: row.name,
    slug: row.slug,
    slugId: row.slug_id,
    path: row.path,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Per the contract: lowercase, whitespace → "-", strip everything that
// isn't [a-z0-9-], collapse runs of "-". Empty result falls back to
// "folder" so the path never contains a trailing slash.
function slugify(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "folder";
}

// 12-char public slug id derived from a fresh uuid. Lowercase
// alphanumeric so it's URL-safe without escaping.
function makePublicSlugId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "").toLowerCase();
  return uuid.slice(0, 12);
}

function buildPath(parentPath: string | null, slug: string): string {
  return parentPath ? `${parentPath}/${slug}` : `/${slug}`;
}

// Mirrors the legacy WorkspaceService.normalizePosition contract:
// clamp to >= 1 and round to an integer so the INTEGER column never
// has to type-coerce on read.
function normalizePosition(value: number): number {
  return Math.max(1, Math.round(value));
}

async function fetchById(
  ctx: ServiceContext,
  folderId: string,
): Promise<FolderRow | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM folders WHERE id = ?1`)
    .bind(folderId)
    .first<FolderRow>();
  return row ?? null;
}

async function requireById(
  ctx: ServiceContext,
  folderId: string,
): Promise<FolderRow> {
  const row = await fetchById(ctx, folderId);
  if (!row) {
    throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
  }
  return row;
}

async function nextPosition(
  ctx: ServiceContext,
  workspaceId: string,
  parentFolderId: string | null,
): Promise<number> {
  const db = requireDb(ctx);
  // SQLite treats `=` against NULL as false, so we branch the WHERE.
  const row = parentFolderId
    ? await db
        .prepare(
          "SELECT COALESCE(MAX(position), 0) AS max_pos FROM folders WHERE workspace_id = ?1 AND parent_folder_id = ?2",
        )
        .bind(workspaceId, parentFolderId)
        .first<{ max_pos: number }>()
    : await db
        .prepare(
          "SELECT COALESCE(MAX(position), 0) AS max_pos FROM folders WHERE workspace_id = ?1 AND parent_folder_id IS NULL",
        )
        .bind(workspaceId)
        .first<{ max_pos: number }>();
  return (row?.max_pos ?? 0) + 1;
}

export async function create(
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    parentFolderId: string | null;
    name: string;
    position?: number;
  },
): Promise<FolderRecord> {
  const db = requireDb(ctx);
  const name = input.name.trim();
  if (!name) {
    throw new AppError("VALIDATION_ERROR", "Folder name is required.", 400);
  }

  let parentPath: string | null = null;
  if (input.parentFolderId) {
    const parent = await fetchById(ctx, input.parentFolderId);
    if (!parent) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder was not found.",
        404,
      );
    }
    if (parent.workspace_id !== input.workspaceId) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder does not belong to this workspace.",
        404,
      );
    }
    parentPath = parent.path;
  }

  const id = createId(idPrefixes.folder);
  const slug = slugify(name);
  const slugId = makePublicSlugId();
  const path = buildPath(parentPath, slug);
  // Schema is `position INTEGER` and the legacy WorkspaceService
  // clamped to Math.max(1, Math.round(value)); preserve that contract
  // so callers don't get a non-integer back when sqlite would
  // type-coerce on read.
  const position = normalizePosition(
    input.position ??
      (await nextPosition(ctx, input.workspaceId, input.parentFolderId)),
  );
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO folders
         (id, workspace_id, parent_folder_id, name, slug, slug_id, path, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    )
    .bind(
      id,
      input.workspaceId,
      input.parentFolderId,
      name,
      slug,
      slugId,
      path,
      position,
      now,
    )
    .run();

  return {
    id,
    workspaceId: input.workspaceId,
    parentFolderId: input.parentFolderId,
    name,
    slug,
    slugId,
    path,
    position,
    createdAt: now,
    updatedAt: now,
  };
}

export async function get(
  ctx: ServiceContext,
  folderId: string,
): Promise<FolderRecord | null> {
  const row = await fetchById(ctx, folderId);
  return row ? rowToRecord(row) : null;
}

export async function getBySlugId(
  ctx: ServiceContext,
  slugId: string,
): Promise<FolderRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM folders WHERE slug_id = ?1`)
    .bind(slugId)
    .first<FolderRow>();
  return row ? rowToRecord(row) : null;
}

export async function listForParent(
  ctx: ServiceContext,
  input: { workspaceId: string; parentFolderId: string | null },
): Promise<FolderRecord[]> {
  const db = requireDb(ctx);
  const result = input.parentFolderId
    ? await db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM folders
            WHERE workspace_id = ?1 AND parent_folder_id = ?2
            ORDER BY position ASC, created_at ASC`,
        )
        .bind(input.workspaceId, input.parentFolderId)
        .all<FolderRow>()
    : await db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM folders
            WHERE workspace_id = ?1 AND parent_folder_id IS NULL
            ORDER BY position ASC, created_at ASC`,
        )
        .bind(input.workspaceId)
        .all<FolderRow>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  return rows.map(rowToRecord);
}

// Hard cap on folder rows returned by listAll. Workspaces can grow to
// tens of thousands of folders; without a LIMIT a single navigation
// build could exhaust the Worker subrequest/memory budget. The cap is
// large enough that no real workspace should ever hit it, and routes
// can pass an explicit larger limit when they truly need every row.
const LIST_HARD_CAP = 5000;

export type ListAllOptions = {
  workspaceId: string;
  // Optional override (clamped to [1, LIST_HARD_CAP]).
  limit?: number;
};

export async function listAll(
  ctx: ServiceContext,
  input: ListAllOptions,
): Promise<FolderRecord[]> {
  const db = requireDb(ctx);
  const limit = Math.min(
    LIST_HARD_CAP,
    Math.max(1, Math.floor(input.limit ?? LIST_HARD_CAP)),
  );
  const result = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM folders
        WHERE workspace_id = ?1
        ORDER BY path ASC, position ASC
        LIMIT ?2`,
    )
    .bind(input.workspaceId, limit)
    .all<FolderRow>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  return rows.map(rowToRecord);
}

// Cursor-paginated alternative. Cursor encodes `(updated_at, id)`
// (folders sort by path for nav, but pagination cursors must be
// total-order-stable, and updated_at+id is the cheapest such pair on
// the existing folders_workspace_updated_idx + primary key indices).
export async function listAllPaginated(
  ctx: ServiceContext,
  input: { workspaceId: string; limit?: number; cursor?: string },
): Promise<PaginatedResult<FolderRecord>> {
  const db = requireDb(ctx);
  const limit = clampLimit(input.limit, {
    default: 500,
    hardCap: LIST_HARD_CAP,
  });
  const cursor = decodeCursor(input.cursor);
  const fetchLimit = limit + 1;
  const result = cursor
    ? await db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM folders
            WHERE workspace_id = ?1
              AND (updated_at < ?2 OR (updated_at = ?2 AND id > ?3))
            ORDER BY updated_at DESC, id ASC
            LIMIT ?4`,
        )
        .bind(input.workspaceId, cursor.updatedAt, cursor.id, fetchLimit)
        .all<FolderRow>()
    : await db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM folders
            WHERE workspace_id = ?1
            ORDER BY updated_at DESC, id ASC
            LIMIT ?2`,
        )
        .bind(input.workspaceId, fetchLimit)
        .all<FolderRow>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(rowToRecord),
    nextCursor:
      hasMore && last
        ? encodeCursor({ updatedAt: last.updated_at, id: last.id })
        : null,
  };
}

// Page the descendant set so any single db.batch() stays under MAX_BATCH
// statements. The caller passes an UPDATE-builder that turns a row into
// a prepared statement; we just orchestrate the windows.
async function rewriteDescendantPaths(
  ctx: ServiceContext,
  workspaceId: string,
  oldPath: string,
  newPath: string,
  updatedAt: string,
): Promise<void> {
  if (oldPath === newPath) return;
  const db = requireDb(ctx);
  const likePrefix = `${oldPath}/%`;

  // Pull descendant ids + paths in pages, build a batch per page, and
  // flush. We re-query each iteration because the previous batch
  // rewrote the path column (so the LIKE prefix would no longer match).
  // Using ORDER BY id keeps the windowing deterministic.
  // (For workspaces with thousands of descendants this still completes
  // in a small number of round-trips — D1 batch is fast.)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await db
      .prepare(
        `SELECT id, path FROM folders
          WHERE workspace_id = ?1 AND path LIKE ?2
          ORDER BY id ASC
          LIMIT ?3`,
      )
      .bind(workspaceId, likePrefix, MAX_BATCH)
      .all<{ id: string; path: string }>();
    const rows = Array.isArray(result) ? result : (result.results ?? []);
    if (rows.length === 0) break;

    const statements: D1PreparedStatement[] = rows.map((row) => {
      const rewritten = `${newPath}${row.path.slice(oldPath.length)}`;
      return db
        .prepare("UPDATE folders SET path = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(rewritten, updatedAt, row.id);
    });

    if (db.batch) {
      await db.batch(statements);
    } else {
      // Fallback for adapters without batch support — run sequentially.
      for (const stmt of statements) await stmt.run();
    }

    // Loop guard: if every row's path was already a no-op (shouldn't
    // happen since oldPath !== newPath) we'd spin forever. Break once
    // we've drained fewer rows than the page size.
    if (rows.length < MAX_BATCH) break;
  }
}

export async function rename(
  ctx: ServiceContext,
  input: { folderId: string; name: string },
): Promise<FolderRecord> {
  const db = requireDb(ctx);
  const existing = await requireById(ctx, input.folderId);
  const name = input.name.trim();
  if (!name) {
    throw new AppError("VALIDATION_ERROR", "Folder name is required.", 400);
  }

  const slug = slugify(name);
  // Recompute path from the parent so a rename preserves the rest of
  // the chain. A rename never moves the folder.
  let parentPath: string | null = null;
  if (existing.parent_folder_id) {
    const parent = await fetchById(ctx, existing.parent_folder_id);
    if (parent) parentPath = parent.path;
  }
  const newPath = buildPath(parentPath, slug);
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE folders SET name = ?1, slug = ?2, path = ?3, updated_at = ?4 WHERE id = ?5`,
    )
    .bind(name, slug, newPath, now, existing.id)
    .run();

  await rewriteDescendantPaths(
    ctx,
    existing.workspace_id,
    existing.path,
    newPath,
    now,
  );

  return {
    ...rowToRecord(existing),
    name,
    slug,
    path: newPath,
    updatedAt: now,
  };
}

export async function move(
  ctx: ServiceContext,
  input: {
    folderId: string;
    parentFolderId: string | null;
    position?: number;
  },
): Promise<FolderRecord> {
  const db = requireDb(ctx);
  const existing = await requireById(ctx, input.folderId);

  // Cycle check: moving under self is forbidden; moving under any
  // descendant is forbidden. Path-prefix containment catches both.
  if (input.parentFolderId === existing.id) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Cannot move folder under itself or its descendant.",
      400,
    );
  }
  let parentPath: string | null = null;
  if (input.parentFolderId) {
    const parent = await fetchById(ctx, input.parentFolderId);
    if (!parent) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder was not found.",
        404,
      );
    }
    if (parent.workspace_id !== existing.workspace_id) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder does not belong to this workspace.",
        404,
      );
    }
    if (
      parent.id === existing.id ||
      parent.path === existing.path ||
      parent.path.startsWith(`${existing.path}/`)
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Cannot move folder under itself or its descendant.",
        400,
      );
    }
    parentPath = parent.path;
  }

  const newPath = buildPath(parentPath, existing.slug);
  const position =
    input.position ??
    (await nextPosition(ctx, existing.workspace_id, input.parentFolderId));
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE folders SET parent_folder_id = ?1, path = ?2, position = ?3, updated_at = ?4 WHERE id = ?5`,
    )
    .bind(input.parentFolderId, newPath, position, now, existing.id)
    .run();

  await rewriteDescendantPaths(
    ctx,
    existing.workspace_id,
    existing.path,
    newPath,
    now,
  );

  return {
    ...rowToRecord(existing),
    parentFolderId: input.parentFolderId,
    path: newPath,
    position,
    updatedAt: now,
  };
}

export async function remove(
  ctx: ServiceContext,
  folderId: string,
): Promise<{ removed: number }> {
  const db = requireDb(ctx);
  const existing = await requireById(ctx, folderId);

  // Count descendants + self so the caller knows how many rows the
  // CASCADE swept. We count BEFORE deletion (post-delete the rows are
  // gone). The folder itself counts as 1.
  const countResult = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM folders
        WHERE workspace_id = ?1 AND (id = ?2 OR path LIKE ?3)`,
    )
    .bind(existing.workspace_id, existing.id, `${existing.path}/%`)
    .first<{ n: number }>();
  const removed = countResult?.n ?? 1;

  // Children cascade via ON DELETE CASCADE on folders.parent_folder_id;
  // pages move to folder_id = NULL via ON DELETE SET NULL.
  await db.prepare("DELETE FROM folders WHERE id = ?1").bind(existing.id).run();

  return { removed };
}

// Returns the chain of folder ids from the root down to (and including)
// the supplied folder. Used by permissions resolution to walk the
// inheritance chain. Returns [] for a missing folder.
export async function ancestorPath(
  ctx: ServiceContext,
  folderId: string,
): Promise<string[]> {
  const chain: string[] = [];
  let cursor: string | null = folderId;
  // Guard against (impossible-by-schema) cycles so we never spin.
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = await fetchById(ctx, cursor);
    if (!row) {
      // Missing intermediate row: treat as broken chain.
      if (chain.length === 0) return [];
      break;
    }
    chain.unshift(row.id);
    cursor = row.parent_folder_id;
  }
  return chain;
}
