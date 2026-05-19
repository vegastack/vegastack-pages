// Permissions service — direct-D1 CRUD on the `permissions` table plus a
// thin wrapper around the pure resolution helpers in
// packages/core/src/permissions.ts.
//
// Plan 011 §5. Replaces the persistence + grant CRUD side of
// packages/core/src/access-control.ts (the class-based PermissionService
// kept an in-memory `Map<string, PermissionRecord>` of grants). The pure
// resolution comparators (`comparePermissions`, `hasPermission`, etc.)
// still live in @vegastack/pages-core and are re-used here — this
// service does NOT re-implement them.
//
// Authorization contract: this module is itself a primitive used by
// callers to decide whether to allow other mutations. `setGrant`,
// `deleteGrant`, and `deleteGrantsForSubject` are administrative
// operations; routes must verify the actor is workspace admin (or
// instance_admin) BEFORE invoking them. `resolve` and `assert` are pure
// reads and are safe to call for any actor — `assert` throws
// PERMISSION_DENIED when the resolved level is below the required one.

import {
  AppError,
  comparePermissions,
  createId,
  hasPermission,
  idPrefixes,
  permissionForWorkspaceRole,
  type PermissionLevel,
} from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

export type { PermissionLevel } from "@vegastack/pages-core";
export type PermissionScope = "workspace" | "folder" | "page";

export type PermissionGrant = {
  id: string;
  workspaceId: string;
  subjectType: "user";
  subjectId: string;
  scope: PermissionScope;
  // workspace_id when scope=workspace; folder_id when scope=folder;
  // page_id when scope=page.
  targetId: string;
  level: PermissionLevel;
  createdAt: string;
  updatedAt: string;
};

type GrantRow = {
  id: string;
  workspace_id: string;
  subject_type: string;
  subject_id: string;
  scope: string;
  target_id: string;
  level: string;
  created_at: string;
  updated_at: string;
};

const SELECT_COLUMNS =
  "id, workspace_id, subject_type, subject_id, scope, target_id, level, created_at, updated_at";

const VALID_SCOPES: ReadonlySet<PermissionScope> = new Set([
  "workspace",
  "folder",
  "page",
]);

const VALID_LEVELS: ReadonlySet<PermissionLevel> = new Set([
  "none",
  "read",
  "comment",
  "write",
  "admin",
]);

function rowToRecord(row: GrantRow): PermissionGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subjectType: "user",
    subjectId: row.subject_id,
    scope: row.scope as PermissionScope,
    targetId: row.target_id,
    level: row.level as PermissionLevel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SetGrantInput = {
  workspaceId: string;
  // userId — subject_type is always 'user' for now.
  subjectId: string;
  scope: PermissionScope;
  targetId: string;
  level: PermissionLevel;
};

// UPSERT on (workspace_id, subject_type, subject_id, scope, target_id):
// inserts a new row or, when one already exists for that subject+scope
// combination, overwrites its `level` and bumps `updated_at`. Returns
// the row as currently stored (the read-back also confirms the write).
export async function setGrant(
  ctx: ServiceContext,
  input: SetGrantInput,
): Promise<PermissionGrant> {
  if (!VALID_SCOPES.has(input.scope)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Invalid permission scope: ${input.scope}`,
      400,
    );
  }
  if (!VALID_LEVELS.has(input.level)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Invalid permission level: ${input.level}`,
      400,
    );
  }

  const db = requireDb(ctx);
  const id = createId(idPrefixes.permission);
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO permissions
         (id, workspace_id, subject_type, subject_id, scope, target_id,
          level, created_at, updated_at)
       VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(workspace_id, subject_type, subject_id, scope, target_id)
       DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      input.workspaceId,
      input.subjectId,
      input.scope,
      input.targetId,
      input.level,
      now,
    )
    .run();

  // Re-read to return the canonical row — preserves the original `id`
  // and `created_at` on update, and serves as a write confirmation.
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM permissions
        WHERE workspace_id = ?1
          AND subject_type = 'user'
          AND subject_id = ?2
          AND scope = ?3
          AND target_id = ?4`,
    )
    .bind(input.workspaceId, input.subjectId, input.scope, input.targetId)
    .first<GrantRow>();
  if (!row) {
    // Should be unreachable: the INSERT above either inserts or updates
    // the unique row.
    throw new AppError(
      "INTERNAL_ERROR",
      "Permission grant write did not persist.",
      500,
    );
  }
  return rowToRecord(row);
}

export type DeleteGrantInput = {
  workspaceId: string;
  subjectId: string;
  scope: PermissionScope;
  targetId: string;
};

export async function deleteGrant(
  ctx: ServiceContext,
  input: DeleteGrantInput,
): Promise<void> {
  const db = requireDb(ctx);
  await db
    .prepare(
      `DELETE FROM permissions
        WHERE workspace_id = ?1
          AND subject_type = 'user'
          AND subject_id = ?2
          AND scope = ?3
          AND target_id = ?4`,
    )
    .bind(input.workspaceId, input.subjectId, input.scope, input.targetId)
    .run();
}

export type DeleteGrantsForSubjectInput = {
  workspaceId: string;
  subjectId: string;
};

export async function deleteGrantsForSubject(
  ctx: ServiceContext,
  input: DeleteGrantsForSubjectInput,
): Promise<{ removed: number }> {
  const db = requireDb(ctx);
  // Count first so we can report `removed` without depending on D1's
  // run() metadata shape (which varies between Cloudflare and
  // node:sqlite).
  const before = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM permissions
        WHERE workspace_id = ?1 AND subject_type = 'user' AND subject_id = ?2`,
    )
    .bind(input.workspaceId, input.subjectId)
    .first<{ c: number }>();
  const removed = before?.c ?? 0;

  if (removed > 0) {
    await db
      .prepare(
        `DELETE FROM permissions
          WHERE workspace_id = ?1
            AND subject_type = 'user'
            AND subject_id = ?2`,
      )
      .bind(input.workspaceId, input.subjectId)
      .run();
  }
  return { removed };
}

export type ListGrantsInput = {
  workspaceId: string;
  subjectId?: string;
  targetId?: string;
};

export async function listGrants(
  ctx: ServiceContext,
  input: ListGrantsInput,
): Promise<PermissionGrant[]> {
  const db = requireDb(ctx);
  // Optional filters are folded into the WHERE clause via IS NULL OR =
  // checks so we can keep a single prepared statement. Index
  // permissions_workspace_subject_idx covers the workspace+subject
  // common case.
  const result = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM permissions
        WHERE workspace_id = ?1
          AND (?2 IS NULL OR subject_id = ?2)
          AND (?3 IS NULL OR target_id = ?3)
        ORDER BY created_at ASC`,
    )
    .bind(input.workspaceId, input.subjectId ?? null, input.targetId ?? null)
    .all<GrantRow>();

  // D1's .all() may return either `T[]` or `{ results: T[] }` depending
  // on the runtime (the union in @vegastack/pages-db covers both).
  const rows: GrantRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);
  return rows.map(rowToRecord);
}

export type ResolveInput = {
  workspaceId: string;
  userId: string;
  scope: PermissionScope;
  targetId: string;
  // Ancestor folder ids (root → immediate parent) for cascade-up
  // resolution when scope is "folder" or "page". The caller is
  // responsible for computing this — the service does not walk the
  // folder tree.
  folderPath?: string[];
  // Workspace membership role, if any. Provides the BASE level when no
  // explicit grants apply.
  memberRole?: "reader" | "commenter" | "editor" | "admin" | null;
  // Instance role of the user. `instance_admin` short-circuits to
  // "admin" for any scope/target — matches access-control.ts behavior.
  instanceRole?: "user" | "instance_admin";
};

// Mirrors the cascade in access-control.ts:
//   1. instance_admin → "admin" (short-circuit)
//   2. base level = member role (or "none" if non-member)
//   3. workspace-scope grant (if any) overrides base
//   4. each folder-scope grant on the ancestor path overrides
//      (root-first → so the closest folder wins on equal precedence)
//   5. page-scope grant (if any) overrides
//
// Uses the pure helpers from packages/core/src/permissions.ts for
// level-to-rank comparison; the cascade itself is just last-wins
// assignment.
export async function resolve(
  ctx: ServiceContext,
  input: ResolveInput,
): Promise<PermissionLevel> {
  if (input.instanceRole === "instance_admin") {
    return "admin";
  }

  let effective: PermissionLevel = input.memberRole
    ? permissionForWorkspaceRole(input.memberRole)
    : "none";

  // Pull every grant for this user in this workspace; in-memory filter
  // by scope+target. Grant counts per user are bounded by workspace
  // size, so the single round-trip beats one query per scope.
  const grants = await listGrants(ctx, {
    workspaceId: input.workspaceId,
    subjectId: input.userId,
  });

  const workspaceGrant = grants.find(
    (grant) =>
      grant.scope === "workspace" && grant.targetId === input.workspaceId,
  );
  if (workspaceGrant) effective = workspaceGrant.level;

  // Only apply folder-path grants when resolving against a folder or
  // page target. For workspace-scope resolution, ancestor folders are
  // irrelevant.
  if (input.scope === "folder" || input.scope === "page") {
    for (const folderId of input.folderPath ?? []) {
      const folderGrant = grants.find(
        (grant) => grant.scope === "folder" && grant.targetId === folderId,
      );
      if (folderGrant) effective = folderGrant.level;
    }
  }

  if (input.scope === "folder") {
    const folderGrant = grants.find(
      (grant) => grant.scope === "folder" && grant.targetId === input.targetId,
    );
    if (folderGrant) effective = folderGrant.level;
  }

  if (input.scope === "page") {
    const pageGrant = grants.find(
      (grant) => grant.scope === "page" && grant.targetId === input.targetId,
    );
    if (pageGrant) effective = pageGrant.level;
  }

  return effective;
}

export type AssertInput = ResolveInput & {
  required: PermissionLevel;
};

export async function assert(
  ctx: ServiceContext,
  input: AssertInput,
): Promise<void> {
  const actual = await resolve(ctx, input);
  // hasPermission(actual, required) returns true when actual >= required.
  if (!hasPermission(actual, input.required)) {
    throw new AppError("PERMISSION_DENIED", "Insufficient permission.", 403, {
      required: input.required,
      actual,
      // Echo back enough context to debug failed assertions in logs
      // without re-querying.
      scope: input.scope,
      targetId: input.targetId,
      comparison: comparePermissions(actual, input.required),
    });
  }
}

// Convenience for routes that have already resolved an actor's level
// (via `lib/access.ts` helpers or a prior `resolve(ctx, …)` call) and
// just need a pure compare-and-throw. Mirrors the legacy
// `permissionService.assert({actual, required})` shape so a one-line
// replacement is enough when migrating routes.
export function assertLevel(input: {
  actual: PermissionLevel;
  required: PermissionLevel;
  scope?: PermissionScope;
  targetId?: string;
}): void {
  if (!hasPermission(input.actual, input.required)) {
    throw new AppError("PERMISSION_DENIED", "Insufficient permission.", 403, {
      required: input.required,
      actual: input.actual,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
    });
  }
}
