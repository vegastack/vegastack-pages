// Users service — direct-D1 reads/writes against the users table.
//
// Plan 011 §5. Replaces the user CRUD methods that lived on the
// class-based WorkspaceService in packages/core/src/workspaces.ts
// (createUser, getUser, getUserByEmail) with plain async functions
// over ServiceContext.
//
// Authorization contract: services here check AUTHENTICATION-adjacent
// invariants (input shape, row existence) only. Routes are responsible
// for verifying the actor has permission to call these mutations
// before invoking the service.

import { AppError, createId, idPrefixes } from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

export type UserRole = "user" | "instance_admin";

export type UserRecord = {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  created_at: string;
  updated_at: string;
};

export type UpsertUserInput = {
  // Optional caller-provided id. When omitted, a new `usr_*` id is
  // generated. Ignored when an existing row matches the email.
  id?: string;
  email: string;
  displayName?: string | null;
  // Defaults to "user". Only honored on first insert; existing rows
  // keep their current role (use setRole() to change it).
  role?: UserRole;
};

export type SetRoleInput = {
  userId: string;
  role: UserRole;
};

function normalizeRole(value: string): UserRole {
  // Schema CHECK constraint guarantees one of these two values.
  return value === "instance_admin" ? "instance_admin" : "user";
}

function rowToRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: normalizeRole(row.role),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = "id, email, display_name, role, created_at, updated_at";

// Creates or returns an existing user (lookup by email, case-insensitive).
// Idempotent: calling again with the same email returns the same row.
export async function upsert(
  ctx: ServiceContext,
  input: UpsertUserInput,
): Promise<UserRecord> {
  const db = requireDb(ctx);
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new AppError("VALIDATION_ERROR", "A valid email is required.", 400);
  }

  const existing = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE email = ?1`)
    .bind(email)
    .first<UserRow>();
  if (existing) return rowToRecord(existing);

  const id = input.id ?? createId(idPrefixes.user);
  const role: UserRole = input.role ?? "user";
  const displayName =
    input.displayName === undefined ? null : input.displayName;
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
    .bind(id, email, displayName, role, now)
    .run();

  return {
    id,
    email,
    displayName,
    role,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getById(
  ctx: ServiceContext,
  userId: string,
): Promise<UserRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE id = ?1`)
    .bind(userId)
    .first<UserRow>();
  return row ? rowToRecord(row) : null;
}

export async function getByEmail(
  ctx: ServiceContext,
  email: string,
): Promise<UserRecord | null> {
  const db = requireDb(ctx);
  const normalized = email.trim().toLowerCase();
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE email = ?1`)
    .bind(normalized)
    .first<UserRow>();
  return row ? rowToRecord(row) : null;
}

export async function setDisplayName(
  ctx: ServiceContext,
  input: { userId: string; displayName: string | null },
): Promise<UserRecord> {
  const db = requireDb(ctx);
  const existing = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE id = ?1`)
    .bind(input.userId)
    .first<UserRow>();
  if (!existing) {
    throw new AppError("USER_NOT_FOUND", "User was not found.", 404);
  }

  const trimmed =
    typeof input.displayName === "string"
      ? input.displayName.trim() || null
      : null;
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE users SET display_name = ?1, updated_at = ?2 WHERE id = ?3",
    )
    .bind(trimmed, now, input.userId)
    .run();

  return {
    ...rowToRecord(existing),
    displayName: trimmed,
    updatedAt: now,
  };
}

export async function setRole(
  ctx: ServiceContext,
  input: SetRoleInput,
): Promise<UserRecord> {
  const db = requireDb(ctx);
  const existing = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE id = ?1`)
    .bind(input.userId)
    .first<UserRow>();
  if (!existing) {
    throw new AppError("USER_NOT_FOUND", "User was not found.", 404);
  }

  const now = new Date().toISOString();
  await db
    .prepare("UPDATE users SET role = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(input.role, now, input.userId)
    .run();

  return {
    ...rowToRecord(existing),
    role: input.role,
    updatedAt: now,
  };
}
