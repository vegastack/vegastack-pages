// Workspaces service — direct-D1 reads/writes for workspaces, members,
// and folder mutations that need to emit a navigation-aware envelope.
//
// Plan 011 §5 phase 12. Rewrites the prior `ctx.repo.workspaces.*`
// implementation onto `ctx.db` (D1). User CRUD lives in users.service
// and pure folder CRUD lives in folders.service — this module focuses
// on the workspace/membership surface and on wrapping folder mutations
// with a MutationEnvelope (so callers receive `tree_version` +
// `changed_resources` post-write).
//
// Authorization contract: services check authentication-adjacent
// invariants only (input shape, row existence). Routes are responsible
// for verifying the actor has permission BEFORE invoking a mutation.

import { createId, idPrefixes, slugifyTitle } from "@vegastack/pages-core";
import type { D1PreparedStatement } from "@vegastack/pages-db";
import type { ServiceContext, MutationEnvelope } from "./context.ts";
import { requireDb } from "./context.ts";
import { clampLimit, decodeCursor, encodeCursor } from "./cursor.ts";
import type { PaginatedResult } from "./cursor.ts";
import type {
  WorkspaceRecord,
  WorkspaceMemberRecord,
  UserRecord,
  FolderRecord,
  WorkspaceRole,
  CreateFolderInput,
} from "./repo/workspace.repo.ts";
import { ServiceError } from "./errors.ts";
import { buildEnvelope } from "./envelope.ts";
import * as folders from "./folders.service.ts";

export type WorkspaceMutation<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

// ---------- row shapes ----------

type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  version_retention_days: number | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceMemberRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  created_at: string;
  updated_at: string;
};

const WORKSPACE_COLUMNS =
  "id, name, slug, version_retention_days, created_at, updated_at";
const MEMBER_COLUMNS =
  "id, workspace_id, user_id, role, created_at, updated_at";
const USER_COLUMNS = "id, email, display_name, role, created_at, updated_at";

function normalizeWorkspaceRole(value: string): WorkspaceRole {
  switch (value) {
    case "admin":
    case "editor":
    case "commenter":
    case "reader":
      return value;
    default:
      return "reader";
  }
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    versionRetentionDays: row.version_retention_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memberFromRow(row: WorkspaceMemberRow): WorkspaceMemberRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: normalizeWorkspaceRole(row.role),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function userFromRow(row: UserRow): UserRecord {
  // WorkspaceRepo's UserRecord declares displayName as a non-null
  // string. The D1 row may carry NULL; fall back to email so callers
  // never see undefined display strings.
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? row.email,
    role: row.role === "instance_admin" ? "instance_admin" : "user",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- reads ----------

export async function whoami(ctx: ServiceContext): Promise<{
  user: UserRecord | null;
  workspaces: WorkspaceRecord[];
}> {
  if (!ctx.actor.userId) {
    return { user: null, workspaces: [] };
  }
  const db = requireDb(ctx);
  const userRow = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`)
    .bind(ctx.actor.userId)
    .first<UserRow>();
  if (!userRow) {
    return { user: null, workspaces: [] };
  }
  const workspaceList = await listForUser(ctx, { userId: userRow.id });
  return { user: userFromRow(userRow), workspaces: workspaceList };
}

export async function list(ctx: ServiceContext): Promise<WorkspaceRecord[]> {
  if (!ctx.actor.userId) return [];
  return listForUser(ctx, { userId: ctx.actor.userId });
}

// Practical upper bound on how many workspaces a single user can be a
// member of in our product. Multi-tenant SaaS scenarios at the high
// end run ~hundreds; the cap is large enough nobody hits it in
// production but small enough that a runaway query can't OOM the
// Worker if the join joins explode.
const WORKSPACES_PER_USER_CAP = 1000;

export async function listForUser(
  ctx: ServiceContext,
  input: { userId: string; limit?: number },
): Promise<WorkspaceRecord[]> {
  const db = requireDb(ctx);
  const limit = Math.min(
    WORKSPACES_PER_USER_CAP,
    Math.max(1, Math.floor(input.limit ?? WORKSPACES_PER_USER_CAP)),
  );
  const result = await db
    .prepare(
      `SELECT ${WORKSPACE_COLUMNS.split(", ")
        .map((column) => `w.${column}`)
        .join(", ")}
        FROM workspaces w
        INNER JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ?1
        ORDER BY w.name ASC
        LIMIT ?2`,
    )
    .bind(input.userId, limit)
    .all<WorkspaceRow>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  return rows.map(workspaceFromRow);
}

// Cursor-paginated alternative. Workspaces sort by name ASC, so the
// cursor encodes `(name, id)` rather than `(updated_at, id)` — same
// shape, different semantic key. The opaque cursor field name in
// `cursor.ts` (`updatedAt`) is the generic sort-timestamp slot.
export async function listForUserPaginated(
  ctx: ServiceContext,
  input: { userId: string; limit?: number; cursor?: string },
): Promise<PaginatedResult<WorkspaceRecord>> {
  const db = requireDb(ctx);
  const limit = clampLimit(input.limit, {
    default: 100,
    hardCap: WORKSPACES_PER_USER_CAP,
  });
  const cursor = decodeCursor(input.cursor);
  const fetchLimit = limit + 1;
  const result = cursor
    ? await db
        .prepare(
          `SELECT ${WORKSPACE_COLUMNS.split(", ")
            .map((column) => `w.${column}`)
            .join(", ")}
            FROM workspaces w
            INNER JOIN workspace_members m ON m.workspace_id = w.id
            WHERE m.user_id = ?1
              AND (w.name > ?2 OR (w.name = ?2 AND w.id > ?3))
            ORDER BY w.name ASC, w.id ASC
            LIMIT ?4`,
        )
        .bind(input.userId, cursor.updatedAt, cursor.id, fetchLimit)
        .all<WorkspaceRow>()
    : await db
        .prepare(
          `SELECT ${WORKSPACE_COLUMNS.split(", ")
            .map((column) => `w.${column}`)
            .join(", ")}
            FROM workspaces w
            INNER JOIN workspace_members m ON m.workspace_id = w.id
            WHERE m.user_id = ?1
            ORDER BY w.name ASC, w.id ASC
            LIMIT ?2`,
        )
        .bind(input.userId, fetchLimit)
        .all<WorkspaceRow>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(workspaceFromRow),
    nextCursor:
      hasMore && last
        ? encodeCursor({ updatedAt: last.name, id: last.id })
        : null,
  };
}

export async function get(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<WorkspaceRecord> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1`)
    .bind(input.workspaceId)
    .first<WorkspaceRow>();
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Workspace was not found.");
  }
  return workspaceFromRow(row);
}

export async function getBySlug(
  ctx: ServiceContext,
  slug: string,
): Promise<WorkspaceRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE slug = ?1`)
    .bind(slug)
    .first<WorkspaceRow>();
  return row ? workspaceFromRow(row) : null;
}

// ---------- workspace mutation ----------

export type CreateWorkspaceInput = {
  id?: string;
  name: string;
  // Optional — defaults to slugifyTitle(name) with a numeric suffix when
  // there's a collision. Set explicitly to control the public URL.
  slug?: string;
  versionRetentionDays?: number | null;
  // When supplied, an `admin` workspace_members row is inserted for
  // that user inside the same db.batch as the workspace row, so the
  // workspace can never appear without its creating admin.
  firstAdminUserId?: string;
};

export async function create(
  ctx: ServiceContext,
  input: CreateWorkspaceInput,
): Promise<WorkspaceRecord> {
  const db = requireDb(ctx);
  const name = input.name.trim();
  if (!name) {
    throw new ServiceError("VALIDATION", "Workspace name is required.");
  }
  // Slug defaulting: derive from the name when the caller didn't supply
  // one. Append a numeric suffix on collision so concurrent setup runs
  // with the same workspace name still succeed.
  let slug = (input.slug ?? "").trim();
  if (!slug) {
    const base = slugifyTitle(name) || "workspace";
    slug = base;
    for (let attempt = 1; attempt < 50; attempt += 1) {
      const taken = await db
        .prepare("SELECT 1 AS hit FROM workspaces WHERE slug = ?1")
        .bind(slug)
        .first<{ hit: number }>();
      if (!taken) break;
      slug = `${base}-${attempt + 1}`;
    }
  }

  const id = input.id ?? createId(idPrefixes.workspace);
  const now = new Date().toISOString();
  const versionRetentionDays =
    input.versionRetentionDays === undefined
      ? null
      : input.versionRetentionDays;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO workspaces
           (id, name, slug, version_retention_days, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      )
      .bind(id, name, slug, versionRetentionDays, now),
  ];

  if (input.firstAdminUserId) {
    const memberId = createId(idPrefixes.workspaceMember);
    statements.push(
      db
        .prepare(
          `INSERT INTO workspace_members
             (id, workspace_id, user_id, role, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'admin', ?4, ?4)`,
        )
        .bind(memberId, id, input.firstAdminUserId, now),
    );
  }

  try {
    if (db.batch && statements.length > 1) {
      await db.batch(statements);
    } else {
      for (const statement of statements) await statement.run();
    }
  } catch (error) {
    // Slug uniqueness violations bubble up as SQLITE_CONSTRAINT.
    if (isUniqueViolation(error)) {
      throw new ServiceError("CONFLICT", "Workspace slug is already in use.", {
        code: "WORKSPACE_SLUG_TAKEN",
      });
    }
    throw error;
  }

  return {
    id,
    name,
    slug,
    versionRetentionDays,
    createdAt: now,
    updatedAt: now,
  };
}

export type UpdateWorkspaceInput = {
  workspaceId: string;
  name?: string;
  slug?: string;
  versionRetentionDays?: number | null;
};

// Partial update for workspace metadata. `undefined` fields are
// preserved; explicit nulls (versionRetentionDays only) clear the value.
// Slug is re-slugified via slugifyTitle for safety; collisions raise
// VALIDATION-style ServiceError.
export async function update(
  ctx: ServiceContext,
  input: UpdateWorkspaceInput,
): Promise<WorkspaceRecord> {
  const db = requireDb(ctx);
  const existing = await get(ctx, { workspaceId: input.workspaceId });

  const name = input.name === undefined ? existing.name : input.name.trim();
  if (!name) {
    throw new ServiceError("VALIDATION", "Workspace name is required.");
  }

  const slug =
    input.slug === undefined ? existing.slug : slugifyTitle(input.slug || name);

  if (slug !== existing.slug) {
    const conflict = await db
      .prepare("SELECT id FROM workspaces WHERE slug = ?1 AND id != ?2 LIMIT 1")
      .bind(slug, existing.id)
      .first<{ id: string }>();
    if (conflict) {
      throw new ServiceError("VALIDATION", "Workspace slug is already in use.");
    }
  }

  const versionRetentionDays =
    input.versionRetentionDays === undefined
      ? existing.versionRetentionDays
      : input.versionRetentionDays;
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE workspaces
          SET name = ?1, slug = ?2, version_retention_days = ?3, updated_at = ?4
        WHERE id = ?5`,
    )
    .bind(name, slug, versionRetentionDays, now, existing.id)
    .run();

  return {
    ...existing,
    name,
    slug,
    versionRetentionDays,
    updatedAt: now,
  };
}

// ---------- members ----------

// Single-row lookup keyed by (workspace_id, user_id). Returns null when
// the user is not a member of the workspace. Used by route + middleware
// auth paths that need to know a caller's role before performing a
// permission check.
export async function getMember(
  ctx: ServiceContext,
  input: { workspaceId: string; userId: string },
): Promise<WorkspaceMemberRecord | null> {
  if (!input.workspaceId || !input.userId) return null;
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM workspace_members
        WHERE workspace_id = ?1 AND user_id = ?2`,
    )
    .bind(input.workspaceId, input.userId)
    .first<WorkspaceMemberRow>();
  return row ? memberFromRow(row) : null;
}

export async function listMembers(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<WorkspaceMemberRecord[]> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in required.");
  }
  const db = requireDb(ctx);
  const result = await db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM workspace_members
        WHERE workspace_id = ?1
        ORDER BY created_at ASC`,
    )
    .bind(input.workspaceId)
    .all<WorkspaceMemberRow>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  return rows.map(memberFromRow);
}

export type AddMemberInput = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  id?: string;
};

// Upsert. If a (workspace_id, user_id) row already exists, its role is
// updated to the supplied value; otherwise a new row is inserted.
export async function addMember(
  ctx: ServiceContext,
  input: AddMemberInput,
): Promise<WorkspaceMemberRecord> {
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  const id = input.id ?? createId(idPrefixes.workspaceMember);

  await db
    .prepare(
      `INSERT INTO workspace_members
         (id, workspace_id, user_id, role, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET
         role = excluded.role,
         updated_at = excluded.updated_at`,
    )
    .bind(id, input.workspaceId, input.userId, input.role, now)
    .run();

  const row = await db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM workspace_members
        WHERE workspace_id = ?1 AND user_id = ?2`,
    )
    .bind(input.workspaceId, input.userId)
    .first<WorkspaceMemberRow>();
  if (!row) {
    // Should be unreachable — we just inserted/updated this row.
    throw new ServiceError("INTERNAL", "Member upsert lost its row.");
  }
  return memberFromRow(row);
}

export async function getMemberById(
  ctx: ServiceContext,
  memberId: string,
): Promise<WorkspaceMemberRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE id = ?1`)
    .bind(memberId)
    .first<WorkspaceMemberRow>();
  return row ? memberFromRow(row) : null;
}

export async function updateMemberRole(
  ctx: ServiceContext,
  input: {
    memberId: string;
    role: WorkspaceRole;
  },
): Promise<WorkspaceMutation<WorkspaceMemberRecord>> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in required.");
  }
  const target = await getMemberById(ctx, input.memberId);
  if (!target) {
    throw new ServiceError("NOT_FOUND", "Workspace member was not found.");
  }
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE workspace_members SET role = ?1, updated_at = ?2 WHERE id = ?3",
    )
    .bind(input.role, now, input.memberId)
    .run();

  const updated: WorkspaceMemberRecord = {
    ...target,
    role: input.role,
    updatedAt: now,
  };
  const treeVersion = await ctx.computeTreeVersion(target.workspaceId);
  return {
    data: updated,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `members:${target.workspaceId}`,
        `member:${updated.id}`,
      ],
    }),
  };
}

export async function removeMember(
  ctx: ServiceContext,
  input: { memberId: string },
): Promise<WorkspaceMutation<WorkspaceMemberRecord>> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in required.");
  }
  const target = await getMemberById(ctx, input.memberId);
  if (!target) {
    throw new ServiceError("NOT_FOUND", "Workspace member was not found.");
  }
  const db = requireDb(ctx);
  await db
    .prepare("DELETE FROM workspace_members WHERE id = ?1")
    .bind(input.memberId)
    .run();

  const treeVersion = await ctx.computeTreeVersion(target.workspaceId);
  return {
    data: target,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `members:${target.workspaceId}`,
        `member:${target.id}`,
      ],
    }),
  };
}

// ---------- folder mutations (envelope-wrapping) ----------

// Delegates the actual INSERT to folders.service and adds the envelope
// the legacy callers depend on.
export async function createFolder(
  ctx: ServiceContext,
  input: CreateFolderInput,
): Promise<WorkspaceMutation<FolderRecord>> {
  const folder = await folders.create(ctx, {
    workspaceId: input.workspaceId,
    parentFolderId: input.parentFolderId,
    name: input.name,
    position: input.position,
  });
  const treeVersion = await ctx.computeTreeVersion(folder.workspaceId);
  return {
    data: folder,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`folder:${folder.id}`],
    }),
  };
}

export async function updateFolder(
  ctx: ServiceContext,
  input: {
    folderId: string;
    name?: string;
    parentFolderId?: string | null;
    position?: number;
  },
): Promise<
  WorkspaceMutation<{ folder: FolderRecord; previous: FolderRecord }>
> {
  const previous = await folders.get(ctx, input.folderId);
  if (!previous) {
    throw new ServiceError("NOT_FOUND", "Folder was not found.");
  }

  // Apply move first (if requested) so the rename's path recompute
  // operates against the new parent. folders.service guards against
  // cross-workspace + cycle moves.
  let current = previous;
  if (input.parentFolderId !== undefined || input.position !== undefined) {
    const parentFolderId =
      input.parentFolderId === undefined
        ? previous.parentFolderId
        : input.parentFolderId;
    current = await folders.move(ctx, {
      folderId: input.folderId,
      parentFolderId,
      position: input.position,
    });
  }
  if (input.name !== undefined) {
    current = await folders.rename(ctx, {
      folderId: input.folderId,
      name: input.name,
    });
  }

  const treeVersion = await ctx.computeTreeVersion(current.workspaceId);
  return {
    data: { folder: current, previous },
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`folder:${current.id}`],
    }),
  };
}

export async function deleteFolder(
  ctx: ServiceContext,
  input: { folderId: string },
): Promise<WorkspaceMutation<FolderRecord>> {
  const existing = await folders.get(ctx, input.folderId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Folder was not found.");
  }
  await folders.remove(ctx, input.folderId);
  const treeVersion = await ctx.computeTreeVersion(existing.workspaceId);
  return {
    data: existing,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`folder:${existing.id}`],
    }),
  };
}

// In-place reorder among siblings (direction = "up" | "down"). The
// folders.service has no reorder primitive yet, so this swaps the
// folder's position with its neighbour via a batched UPDATE pair.
export async function reorderFolder(
  ctx: ServiceContext,
  input: {
    folderId: string;
    direction: "up" | "down";
  },
): Promise<
  WorkspaceMutation<{ folder: FolderRecord; siblings: FolderRecord[] }>
> {
  const db = requireDb(ctx);
  const existing = await folders.get(ctx, input.folderId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Folder was not found.");
  }

  const siblings = await folders.listForParent(ctx, {
    workspaceId: existing.workspaceId,
    parentFolderId: existing.parentFolderId,
  });
  const index = siblings.findIndex((entry) => entry.id === existing.id);
  const targetIndex = input.direction === "up" ? index - 1 : index + 1;

  if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) {
    // No-op at the boundary — still emit a fresh envelope so the
    // caller's cache header stays in sync.
    const treeVersion = await ctx.computeTreeVersion(existing.workspaceId);
    return {
      data: { folder: existing, siblings },
      envelope: buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`folder:${existing.id}`],
      }),
    };
  }

  // Rewrite every sibling's position to its new index+1 in one batch
  // so partial failure can't leave the order half-applied.
  const reordered = [...siblings];
  const [moved] = reordered.splice(index, 1);
  if (!moved) {
    // Shouldn't happen — index was valid.
    const treeVersion = await ctx.computeTreeVersion(existing.workspaceId);
    return {
      data: { folder: existing, siblings },
      envelope: buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`folder:${existing.id}`],
      }),
    };
  }
  reordered.splice(targetIndex, 0, moved);
  const now = new Date().toISOString();

  const updates: D1PreparedStatement[] = reordered.map((entry, idx) =>
    db
      .prepare(
        "UPDATE folders SET position = ?1, updated_at = ?2 WHERE id = ?3",
      )
      .bind(idx + 1, now, entry.id),
  );
  if (db.batch) {
    await db.batch(updates);
  } else {
    for (const stmt of updates) await stmt.run();
  }

  const updatedSiblings = reordered.map((entry, idx) => ({
    ...entry,
    position: idx + 1,
    updatedAt: now,
  }));
  const updatedFolder =
    updatedSiblings.find((entry) => entry.id === existing.id) ?? existing;

  const treeVersion = await ctx.computeTreeVersion(existing.workspaceId);
  return {
    data: { folder: updatedFolder, siblings: updatedSiblings },
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `folder:${updatedFolder.id}`,
        ...updatedSiblings.map((entry) => `folder:${entry.id}`),
      ],
    }),
  };
}

export async function listFolders(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<FolderRecord[]> {
  return folders.listAll(ctx, { workspaceId: input.workspaceId });
}

// ---------- helpers ----------

function isUniqueViolation(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  // node:sqlite + D1 both surface unique-index failures as
  // "UNIQUE constraint failed: <table>.<col>".
  return /UNIQUE constraint failed/i.test(message);
}
