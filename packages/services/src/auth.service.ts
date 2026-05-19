// Auth service — direct-D1 reads/writes against auth_sessions, magic_links,
// and auth_identities.
//
// Plan 011 §5 phase 3. Replaces the in-memory AuthService class in
// packages/core/src/auth.ts with plain async functions over ServiceContext.
//
// Authorization contract: this service handles AUTHENTICATION primitives
// (session lifecycle, magic-link single-use, identity upserts). Callers
// are responsible for:
//   - hashing the raw magic-link token BEFORE calling createMagicLink /
//     consumeMagicLink (token_hash is what's persisted); the service
//     never sees the raw token.
//   - verifying the actor has permission to mutate identities.
//
// Race safety (plan 011 audit finding B-1 / H-1): consumeMagicLink is a
// SINGLE atomic UPDATE … RETURNING. There is NO read-then-write path,
// so two concurrent consume calls cannot both succeed — the database's
// row lock decides exactly one winner.

import { AppError, createId, idPrefixes } from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
};

export type MagicLinkRecord = {
  id: string;
  email: string;
  tokenHash: string;
  redirectTo: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type AuthProvider = "email" | "google";

export type AuthIdentityRecord = {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  email: string;
  createdAt: string;
  updatedAt: string;
};

// Defaults agreed in plan 011 §5: 30-day sessions, 15-minute magic links.
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MAGIC_LINK_TTL_SECONDS = 15 * 60;

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
};

type MagicLinkRow = {
  id: string;
  email: string;
  token_hash: string;
  redirect_to: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

type IdentityRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_subject: string;
  email: string;
  created_at: string;
  updated_at: string;
};

const SESSION_COLUMNS = "id, user_id, expires_at, created_at";
const MAGIC_LINK_COLUMNS =
  "id, email, token_hash, redirect_to, expires_at, consumed_at, created_at";
const IDENTITY_COLUMNS =
  "id, user_id, provider, provider_subject, email, created_at, updated_at";

function sessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function magicLinkRow(row: MagicLinkRow): MagicLinkRecord {
  return {
    id: row.id,
    email: row.email,
    tokenHash: row.token_hash,
    redirectTo: row.redirect_to,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function normalizeProvider(value: string): AuthProvider {
  // Schema CHECK constraint guarantees one of these two values.
  return value === "google" ? "google" : "email";
}

function identityRow(row: IdentityRow): AuthIdentityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: normalizeProvider(row.provider),
    providerSubject: row.provider_subject,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ttlIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type CreateSessionInput = {
  userId: string;
  // Defaults to 30 days. Must be positive.
  ttlSeconds?: number;
};

export async function createSession(
  ctx: ServiceContext,
  input: CreateSessionInput,
): Promise<SessionRecord> {
  if (!input.userId) {
    throw new AppError("VALIDATION_ERROR", "userId is required.", 400);
  }
  const ttl = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "ttlSeconds must be a positive number.",
      400,
    );
  }

  const db = requireDb(ctx);
  const id = createId(idPrefixes.session);
  const now = new Date().toISOString();
  const expiresAt = ttlIso(ttl);

  await db
    .prepare(
      `INSERT INTO auth_sessions (id, user_id, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(id, input.userId, expiresAt, now)
    .run();

  return {
    id,
    userId: input.userId,
    expiresAt,
    createdAt: now,
  };
}

// Returns null if the session does not exist OR has expired. Expired rows
// are not auto-deleted here — sweepExpiredSessions is the GC entry point.
export async function getSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<SessionRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM auth_sessions WHERE id = ?1`)
    .bind(sessionId)
    .first<SessionRow>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return sessionRow(row);
}

export async function destroySession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<void> {
  const db = requireDb(ctx);
  await db
    .prepare("DELETE FROM auth_sessions WHERE id = ?1")
    .bind(sessionId)
    .run();
}

// Deletes every session whose expires_at has passed. Returns the count of
// rows considered deleted by polling the table size before/after, since
// D1's run() result shape varies across runtimes.
export async function sweepExpiredSessions(
  ctx: ServiceContext,
): Promise<{ deleted: number }> {
  const db = requireDb(ctx);
  const nowIso = new Date().toISOString();
  const before = await db
    .prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at <= ?1")
    .bind(nowIso)
    .first<{ n: number }>();
  await db
    .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?1")
    .bind(nowIso)
    .run();
  return { deleted: before?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// Magic links
// ---------------------------------------------------------------------------

export type CreateMagicLinkInput = {
  email: string;
  // SHA-256 (or stronger) hex digest of the raw token. The raw token
  // never enters this service — callers email it to the user and only
  // pass the hash here so the database stores nothing useful by itself.
  tokenHash: string;
  redirectTo: string;
  // Defaults to 15 minutes.
  ttlSeconds?: number;
};

export async function createMagicLink(
  ctx: ServiceContext,
  input: CreateMagicLinkInput,
): Promise<MagicLinkRecord> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new AppError("VALIDATION_ERROR", "A valid email is required.", 400);
  }
  if (!input.tokenHash) {
    throw new AppError("VALIDATION_ERROR", "tokenHash is required.", 400);
  }
  const ttl = input.ttlSeconds ?? DEFAULT_MAGIC_LINK_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "ttlSeconds must be a positive number.",
      400,
    );
  }

  const db = requireDb(ctx);
  const id = createId(idPrefixes.magicLink);
  const now = new Date().toISOString();
  const expiresAt = ttlIso(ttl);

  await db
    .prepare(
      `INSERT INTO magic_links
         (id, email, token_hash, redirect_to, expires_at, consumed_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`,
    )
    .bind(id, email, input.tokenHash, input.redirectTo, expiresAt, now)
    .run();

  return {
    id,
    email,
    tokenHash: input.tokenHash,
    redirectTo: input.redirectTo,
    expiresAt,
    consumedAt: null,
    createdAt: now,
  };
}

export type ConsumeMagicLinkInput = {
  tokenHash: string;
};

// Atomic single-statement consume. Returns the post-update row if this
// caller was the first to flip consumed_at; returns null if the row was
// already consumed, expired, or never existed.
//
// Per plan 011 §5 phase 3 + audit finding B-1/H-1: there is no SELECT
// preceding the UPDATE. Two concurrent calls with the same token_hash
// race on the row lock — exactly one UPDATE sees consumed_at IS NULL,
// and only that caller receives the RETURNING row.
export async function consumeMagicLink(
  ctx: ServiceContext,
  input: ConsumeMagicLinkInput,
): Promise<MagicLinkRecord | null> {
  if (!input.tokenHash) return null;
  const db = requireDb(ctx);
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE magic_links
         SET consumed_at = ?2
       WHERE token_hash = ?1
         AND consumed_at IS NULL
         AND expires_at > ?3
       RETURNING ${MAGIC_LINK_COLUMNS}`,
    )
    .bind(input.tokenHash, nowIso, nowIso)
    .first<MagicLinkRow>();
  return row ? magicLinkRow(row) : null;
}

// ---------------------------------------------------------------------------
// Identities (linked third-party logins)
// ---------------------------------------------------------------------------

export type UpsertIdentityInput = {
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  email: string;
};

// Idempotent upsert keyed by (provider, provider_subject). If the row
// exists, user_id/email are updated and updated_at is refreshed; if it
// doesn't, a new aid_* row is inserted. The UNIQUE index on
// (provider, provider_subject) keeps two concurrent inserts from
// duplicating — the loser falls through to the UPDATE branch.
export async function upsertIdentity(
  ctx: ServiceContext,
  input: UpsertIdentityInput,
): Promise<AuthIdentityRecord> {
  if (!input.userId) {
    throw new AppError("VALIDATION_ERROR", "userId is required.", 400);
  }
  if (input.provider !== "email" && input.provider !== "google") {
    throw new AppError(
      "VALIDATION_ERROR",
      "provider must be 'email' or 'google'.",
      400,
    );
  }
  if (!input.providerSubject) {
    throw new AppError("VALIDATION_ERROR", "providerSubject is required.", 400);
  }
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new AppError("VALIDATION_ERROR", "A valid email is required.", 400);
  }

  const db = requireDb(ctx);
  const existing = await db
    .prepare(
      `SELECT ${IDENTITY_COLUMNS}
         FROM auth_identities
        WHERE provider = ?1 AND provider_subject = ?2`,
    )
    .bind(input.provider, input.providerSubject)
    .first<IdentityRow>();

  const now = new Date().toISOString();
  if (existing) {
    await db
      .prepare(
        `UPDATE auth_identities
            SET user_id = ?1, email = ?2, updated_at = ?3
          WHERE id = ?4`,
      )
      .bind(input.userId, email, now, existing.id)
      .run();
    return {
      id: existing.id,
      userId: input.userId,
      provider: input.provider,
      providerSubject: input.providerSubject,
      email,
      createdAt: existing.created_at,
      updatedAt: now,
    };
  }

  const id = createId(idPrefixes.authIdentity);
  await db
    .prepare(
      `INSERT INTO auth_identities
         (id, user_id, provider, provider_subject, email, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
    .bind(id, input.userId, input.provider, input.providerSubject, email, now)
    .run();

  return {
    id,
    userId: input.userId,
    provider: input.provider,
    providerSubject: input.providerSubject,
    email,
    createdAt: now,
    updatedAt: now,
  };
}

export type FindIdentityInput = {
  provider: string;
  providerSubject: string;
};

export async function findIdentity(
  ctx: ServiceContext,
  input: FindIdentityInput,
): Promise<AuthIdentityRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT ${IDENTITY_COLUMNS}
         FROM auth_identities
        WHERE provider = ?1 AND provider_subject = ?2`,
    )
    .bind(input.provider, input.providerSubject)
    .first<IdentityRow>();
  return row ? identityRow(row) : null;
}
