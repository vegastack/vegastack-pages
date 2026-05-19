// MCP sessions service — direct-D1 reads/writes against the agent_sessions
// and mcp_sessions tables.
//
// Plan 011 §5 phase 17. Replaces the class-based createMcpSession /
// rotateMcpSessionTokens / revokeMcpSession / getMcpSession /
// findMcpSessionByRefreshToken helpers in apps/web/src/lib/runtime.ts
// with plain async functions over ServiceContext.
//
// Authorization contract: this service handles MCP SESSION LIFECYCLE
// primitives. Callers (apps/web/src/pages/api/mcp/sessions.ts, the OAuth
// token + revoke endpoints, and apps/web/src/pages/mcp.ts) are responsible
// for:
//   - hashing any raw bearer / refresh token BEFORE calling
//     createMcpSession / findByRefreshToken / rotateTokens; the service
//     never sees the raw token.
//   - verifying the actor owns the session before invoking revoke /
//     rotateTokens.
//
// Race safety (plan 011 §5 phase 17 — "token rotation already in d1Batch
// — mostly cleanup"): rotateTokens executes a single atomic UPDATE …
// RETURNING. There is NO read-then-write path, so two concurrent rotates
// for the same sessionId cannot both bump expires_at to different values —
// the database's row lock decides exactly one winner. revoke is similarly
// a single UPDATE.

import { AppError, createId, idPrefixes } from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

export type AgentSessionKind = "manual" | "cli" | "oauth";

export type AgentSessionRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  clientName: string;
  clientVersion: string | null;
  model: string | null;
  kind: AgentSessionKind;
  userAgent: string | null;
  lastOrigin: string | null;
  oauthClientId: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type McpSessionRecord = {
  id: string;
  workspaceId: string | null;
  userId: string | null;
  agentSessionId: string | null;
  protocolVersion: string | null;
  refreshTokenHash: string | null;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Defaults agreed in plan 011 §5 phase 17: 1-hour access tokens,
// 30-day refresh tokens. Matches the legacy in-memory behaviour in
// apps/web/src/lib/runtime.ts.
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

type AgentSessionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  client_name: string;
  client_version: string | null;
  model: string | null;
  kind: string;
  user_agent: string | null;
  last_origin: string | null;
  oauth_client_id: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

type McpSessionRow = {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  agent_session_id: string | null;
  protocol_version: string | null;
  refresh_token_hash: string | null;
  refresh_token_expires_at: string | null;
  scope: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

const AGENT_SESSION_COLUMNS =
  "id, workspace_id, user_id, client_name, client_version, model, kind, user_agent, last_origin, oauth_client_id, last_seen_at, created_at, updated_at";

const MCP_SESSION_COLUMNS =
  "id, workspace_id, user_id, agent_session_id, protocol_version, refresh_token_hash, refresh_token_expires_at, scope, expires_at, created_at, updated_at";

function normalizeKind(value: string): AgentSessionKind {
  // Schema default is 'manual'; the legacy runtime only ever wrote one of
  // these three values, so anything else is a corrupted row — fall back to
  // 'manual' rather than throwing.
  return value === "cli" || value === "oauth" ? value : "manual";
}

function agentSessionFromRow(row: AgentSessionRow): AgentSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    clientName: row.client_name,
    clientVersion: row.client_version,
    model: row.model,
    kind: normalizeKind(row.kind),
    userAgent: row.user_agent,
    lastOrigin: row.last_origin,
    oauthClientId: row.oauth_client_id,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mcpSessionFromRow(row: McpSessionRow): McpSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    agentSessionId: row.agent_session_id,
    protocolVersion: row.protocol_version,
    refreshTokenHash: row.refresh_token_hash,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    scope: row.scope,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ttlIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function requirePositiveTtl(seconds: number, label: string): void {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} must be a positive number.`,
      400,
    );
  }
}

// ---------------------------------------------------------------------------
// Agent sessions
// ---------------------------------------------------------------------------

export type CreateAgentSessionInput = {
  workspaceId: string;
  userId: string;
  clientName: string;
  clientVersion?: string;
  model?: string;
  kind?: AgentSessionKind;
  userAgent?: string;
  oauthClientId?: string;
};

export async function createAgentSession(
  ctx: ServiceContext,
  input: CreateAgentSessionInput,
): Promise<AgentSessionRecord> {
  if (!input.workspaceId) {
    throw new AppError("VALIDATION_ERROR", "workspaceId is required.", 400);
  }
  if (!input.userId) {
    throw new AppError("VALIDATION_ERROR", "userId is required.", 400);
  }
  const clientName = input.clientName.trim();
  if (!clientName) {
    throw new AppError("VALIDATION_ERROR", "clientName is required.", 400);
  }
  const kind: AgentSessionKind = input.kind ?? "manual";
  if (kind !== "manual" && kind !== "cli" && kind !== "oauth") {
    throw new AppError(
      "VALIDATION_ERROR",
      "kind must be 'manual', 'cli', or 'oauth'.",
      400,
    );
  }

  const db = requireDb(ctx);
  const id = createId(idPrefixes.agentSession);
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO agent_sessions
         (id, workspace_id, user_id, client_name, client_version, model,
          kind, user_agent, last_origin, oauth_client_id,
          last_seen_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?10, ?10)`,
    )
    .bind(
      id,
      input.workspaceId,
      input.userId,
      clientName,
      input.clientVersion ?? null,
      input.model ?? null,
      kind,
      input.userAgent ?? null,
      input.oauthClientId ?? null,
      now,
    )
    .run();

  return {
    id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    clientName,
    clientVersion: input.clientVersion ?? null,
    model: input.model ?? null,
    kind,
    userAgent: input.userAgent ?? null,
    lastOrigin: null,
    oauthClientId: input.oauthClientId ?? null,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export type TouchAgentSessionInput = {
  sessionId: string;
  origin?: string;
};

// Single-statement UPDATE that bumps last_seen_at unconditionally and
// COALESCEs last_origin so a caller without an origin doesn't clobber a
// previously-recorded one.
export async function touchAgentSession(
  ctx: ServiceContext,
  input: TouchAgentSessionInput,
): Promise<void> {
  if (!input.sessionId) {
    throw new AppError("VALIDATION_ERROR", "sessionId is required.", 400);
  }
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE agent_sessions
          SET last_seen_at = ?2,
              last_origin = COALESCE(?3, last_origin),
              updated_at = ?2
        WHERE id = ?1`,
    )
    .bind(input.sessionId, now, input.origin ?? null)
    .run();
}

// Read an agent session by id. Used by OAuth refresh-token rotation to
// verify the supplied client_id matches the client the session was
// originally issued to (RFC 6749 §10.4 — a leaked refresh token must
// not be redeemable by any registered client).
export async function getAgentSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<AgentSessionRecord | null> {
  if (!sessionId) return null;
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT id, workspace_id, user_id, client_name, client_version, model,
              kind, user_agent, last_origin, oauth_client_id,
              last_seen_at, created_at, updated_at
         FROM agent_sessions WHERE id = ?1`,
    )
    .bind(sessionId)
    .first<AgentSessionRow>();
  return row ? agentSessionFromRow(row) : null;
}

// ---------------------------------------------------------------------------
// MCP sessions
// ---------------------------------------------------------------------------

export type CreateMcpSessionInput = {
  workspaceId?: string | null;
  userId?: string | null;
  agentSessionId?: string | null;
  protocolVersion?: string;
  refreshTokenHash?: string;
  refreshTokenTtlSeconds?: number;
  scope?: string;
  ttlSeconds?: number;
};

export async function createMcpSession(
  ctx: ServiceContext,
  input: CreateMcpSessionInput,
): Promise<McpSessionRecord> {
  const ttl = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  requirePositiveTtl(ttl, "ttlSeconds");
  const refreshTtl =
    input.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
  requirePositiveTtl(refreshTtl, "refreshTokenTtlSeconds");

  const db = requireDb(ctx);
  const id = createId(idPrefixes.mcpSession);
  const now = new Date().toISOString();
  const expiresAt = ttlIso(ttl);
  const refreshHash = input.refreshTokenHash ?? null;
  // Only set refresh_token_expires_at when a hash is present — otherwise
  // the row holds no refresh token and the expiry would be meaningless.
  const refreshExpiresAt = refreshHash ? ttlIso(refreshTtl) : null;

  await db
    .prepare(
      `INSERT INTO mcp_sessions
         (id, workspace_id, user_id, agent_session_id, protocol_version,
          refresh_token_hash, refresh_token_expires_at, scope, expires_at,
          created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    )
    .bind(
      id,
      input.workspaceId ?? null,
      input.userId ?? null,
      input.agentSessionId ?? null,
      input.protocolVersion ?? null,
      refreshHash,
      refreshExpiresAt,
      input.scope ?? null,
      expiresAt,
      now,
    )
    .run();

  return {
    id,
    workspaceId: input.workspaceId ?? null,
    userId: input.userId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    protocolVersion: input.protocolVersion ?? null,
    refreshTokenHash: refreshHash,
    refreshTokenExpiresAt: refreshExpiresAt,
    scope: input.scope ?? null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getMcpSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<McpSessionRecord | null> {
  if (!sessionId) return null;
  const db = requireDb(ctx);
  const row = await db
    .prepare(`SELECT ${MCP_SESSION_COLUMNS} FROM mcp_sessions WHERE id = ?1`)
    .bind(sessionId)
    .first<McpSessionRow>();
  return row ? mcpSessionFromRow(row) : null;
}

// Bearer-token authentication: the OAuth/MCP token endpoint hands the
// client a session id as the bearer. Routes that consume the
// `Authorization: Bearer <id>` header look up the corresponding row
// via this helper. The lookup is by primary key (id) — fast, indexed.
// expires_at is enforced server-side so revoked/expired tokens
// cannot authenticate even before the row is GC'd.
// Returns null on empty input, no match, or expired row.
export async function findByBearerToken(
  ctx: ServiceContext,
  bearerToken: string,
): Promise<McpSessionRecord | null> {
  if (!bearerToken) return null;
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT ${MCP_SESSION_COLUMNS} FROM mcp_sessions
        WHERE id = ?1
          AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .bind(bearerToken, now)
    .first<McpSessionRow>();
  return row ? mcpSessionFromRow(row) : null;
}

// Lookup via the unique partial index mcp_sessions_refresh_hash_unique
// WHERE refresh_token_hash IS NOT NULL. An empty / null input is rejected
// fast so we don't accidentally match revoked rows (which have
// refresh_token_hash = NULL but are still indexed-excluded).
// refresh_token_expires_at is enforced server-side so expired refresh
// tokens cannot rotate even before GC.
export async function findByRefreshToken(
  ctx: ServiceContext,
  refreshTokenHash: string,
): Promise<McpSessionRecord | null> {
  if (!refreshTokenHash) return null;
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT ${MCP_SESSION_COLUMNS}
         FROM mcp_sessions
        WHERE refresh_token_hash = ?1
          AND (refresh_token_expires_at IS NULL OR refresh_token_expires_at > ?2)`,
    )
    .bind(refreshTokenHash, now)
    .first<McpSessionRow>();
  return row ? mcpSessionFromRow(row) : null;
}

export type RotateTokensInput = {
  sessionId: string;
  newRefreshTokenHash: string;
  refreshTokenTtlSeconds?: number;
  ttlSeconds?: number;
};

// Atomic single-statement rotation. Bumps expires_at +
// refresh_token_expires_at + refresh_token_hash + updated_at in one UPDATE
// and returns the post-update row via RETURNING. If no row matches the
// supplied sessionId, throws MCP_SESSION_NOT_FOUND so callers don't have
// to do a separate existence check.
//
// Plan 011 §5 phase 17: this is the canonical replacement for the legacy
// d1Batch-wrapped rotation in apps/web/src/lib/runtime.ts. The legacy
// version also rotated the row's PRIMARY KEY (id) and the linked
// agent_sessions.id; that complexity is gone — the new contract keeps
// ids stable and only rotates token material, which is what every caller
// actually needs.
export async function rotateTokens(
  ctx: ServiceContext,
  input: RotateTokensInput,
): Promise<McpSessionRecord> {
  if (!input.sessionId) {
    throw new AppError("VALIDATION_ERROR", "sessionId is required.", 400);
  }
  if (!input.newRefreshTokenHash) {
    throw new AppError(
      "VALIDATION_ERROR",
      "newRefreshTokenHash is required.",
      400,
    );
  }
  const ttl = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  requirePositiveTtl(ttl, "ttlSeconds");
  const refreshTtl =
    input.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
  requirePositiveTtl(refreshTtl, "refreshTokenTtlSeconds");

  const db = requireDb(ctx);
  const now = new Date().toISOString();
  const expiresAt = ttlIso(ttl);
  const refreshExpiresAt = ttlIso(refreshTtl);

  // Atomic rotation: stash the OLD refresh_token_hash into
  // previous_refresh_token_hash before overwriting. This lets
  // findByRefreshToken detect a replay of the just-rotated token and
  // revoke the entire session chain (RFC 6749 §10.4).
  const row = await db
    .prepare(
      `UPDATE mcp_sessions
          SET previous_refresh_token_hash = refresh_token_hash,
              refresh_token_hash = ?2,
              refresh_token_expires_at = ?3,
              expires_at = ?4,
              updated_at = ?5
        WHERE id = ?1
       RETURNING ${MCP_SESSION_COLUMNS}`,
    )
    .bind(
      input.sessionId,
      input.newRefreshTokenHash,
      refreshExpiresAt,
      expiresAt,
      now,
    )
    .first<McpSessionRow>();

  if (!row) {
    throw new AppError(
      "MCP_SESSION_NOT_FOUND",
      `MCP session not found: ${input.sessionId}`,
      404,
    );
  }
  return mcpSessionFromRow(row);
}

// Replay detection: looks up a session by its PREVIOUS (rotated-away)
// refresh-token hash. If this returns a row, the supplied token was
// already used — the caller must treat it as compromised and revoke
// the session chain. Returns null on no match.
export async function findByPreviousRefreshToken(
  ctx: ServiceContext,
  refreshTokenHash: string,
): Promise<McpSessionRecord | null> {
  if (!refreshTokenHash) return null;
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT ${MCP_SESSION_COLUMNS}
         FROM mcp_sessions
        WHERE previous_refresh_token_hash = ?1`,
    )
    .bind(refreshTokenHash)
    .first<McpSessionRow>();
  return row ? mcpSessionFromRow(row) : null;
}

// Atomic single-statement revoke. Sets refresh_token_hash = NULL (which
// drops the row from the unique partial index, so subsequent
// findByRefreshToken calls cannot reach it) and forces expires_at = now
// so any in-flight access-token check immediately fails.
//
// Idempotent: revoking an already-revoked or nonexistent session is a
// no-op — the UPDATE simply matches zero rows.
export async function revoke(
  ctx: ServiceContext,
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE mcp_sessions
          SET refresh_token_hash = NULL,
              refresh_token_expires_at = NULL,
              expires_at = ?2,
              updated_at = ?2
        WHERE id = ?1`,
    )
    .bind(sessionId, now)
    .run();
}

export type ListForUserInput = {
  workspaceId: string;
  userId: string;
};

export async function listForUser(
  ctx: ServiceContext,
  input: ListForUserInput,
): Promise<McpSessionRecord[]> {
  if (!input.workspaceId) {
    throw new AppError("VALIDATION_ERROR", "workspaceId is required.", 400);
  }
  if (!input.userId) {
    throw new AppError("VALIDATION_ERROR", "userId is required.", 400);
  }
  const db = requireDb(ctx);
  const result = await db
    .prepare(
      `SELECT ${MCP_SESSION_COLUMNS}
         FROM mcp_sessions
        WHERE workspace_id = ?1 AND user_id = ?2
        ORDER BY created_at DESC`,
    )
    .bind(input.workspaceId, input.userId)
    .all<McpSessionRow>();
  // D1's .all() may return either `T[]` or `{ results: T[] }` depending
  // on the runtime (the type union in @vegastack/pages-db covers both).
  const rows: McpSessionRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);
  return rows.map(mcpSessionFromRow);
}

// Re-export the AgentSessionRecord row mapper for the limited set of
// callers (currently zero — kept private) that might want it. This is
// intentionally NOT exported in index.ts to keep the public surface tight.
export { agentSessionFromRow as _agentSessionFromRow };
