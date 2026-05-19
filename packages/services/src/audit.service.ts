// Audit service — direct-D1 reads/writes against the audit_logs table.
//
// Plan 011 §5. Replaces packages/core/src/audit.ts (class-based,
// in-memory `AuditService`) with plain async functions over
// ServiceContext.
//
// Authorization contract: routes are responsible for verifying the
// caller has permission to record/read audit events for a workspace.
// `record()` itself does not assert authentication (actorUserId can be
// null for system-emitted events such as scheduled jobs or background
// retries); `list()` is a pure read by workspaceId and likewise does
// not check the actor here.

import { createId, idPrefixes } from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

export type AuditLogRecord = {
  id: string;
  workspaceId: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RecordAuditInput = {
  workspaceId: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
};

export type ListAuditInput = {
  // Required for workspace-scoped reads; pass `null` to list across
  // every workspace (instance-admin view).
  workspaceId: string | null;
  limit?: number;
  // Keyset cursor: when set, return rows strictly older than this id.
  // Combined with the (workspace_id, created_at DESC) index this yields
  // bounded reverse-chronological pagination.
  afterId?: string;
};

type AuditRow = {
  id: string;
  workspace_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json: string;
  created_at: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function rowToRecord(row: AuditRow): AuditLogRecord {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    // CHECK (json_valid(...)) guarantees this never happens for rows we
    // write, but defend against legacy / out-of-band inserts.
    metadata = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata,
    createdAt: row.created_at,
  };
}

// PII scrubbing — when `VPG_AUDIT_PII` is not "true" (the default),
// known-PII metadata keys are hashed or dropped before persistence.
//
//   `ua`  — user-agent string. Dropped entirely; trends are inferred
//           from sampled HTTP logs at the edge, not from audit rows.
//   `ip`  — client IP. SHA-256-hashed with the deploy-wide salt
//           (`VPG_AUDIT_IP_SALT`, defaults to a fixed dev salt) so
//           individual IPs stay unrecoverable but per-actor patterns
//           remain analyzable (same IP → same hash).
//
// Set `VPG_AUDIT_PII=true` for environments that need raw values
// (legal/compliance audits, incident forensics). The default is
// privacy-by-default.
const PII_SALT_DEFAULT = "vpg-audit-default-salt";

async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  // Truncate to 16 hex chars (64 bits) — keeps the hash short for
  // storage but preserves enough entropy to distinguish per-IP
  // patterns inside a deployment.
  return hex.slice(0, 16);
}

async function scrubMetadata(
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (process.env.VPG_AUDIT_PII === "true") return metadata;
  const scrubbed: Record<string, unknown> = {};
  const salt = process.env.VPG_AUDIT_IP_SALT ?? PII_SALT_DEFAULT;
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "ua") continue; // drop user-agent
    if (key === "ip" && typeof value === "string" && value) {
      scrubbed.ip_hash = await hashIp(value, salt);
      continue;
    }
    scrubbed[key] = value;
  }
  return scrubbed;
}

export async function record(
  ctx: ServiceContext,
  input: RecordAuditInput,
): Promise<AuditLogRecord> {
  const db = requireDb(ctx);
  const id = createId(idPrefixes.auditLog);
  const createdAt = new Date().toISOString();
  const metadata = await scrubMetadata(input.metadata ?? {});
  const metadataJson = JSON.stringify(metadata);

  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, workspace_id, actor_user_id, action, target_type, target_id,
          metadata_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      id,
      input.workspaceId,
      input.actorUserId,
      input.action,
      input.targetType,
      input.targetId,
      metadataJson,
      createdAt,
    )
    .run();

  return {
    id,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata,
    createdAt,
  };
}

export async function list(
  ctx: ServiceContext,
  input: ListAuditInput,
): Promise<AuditLogRecord[]> {
  const db = requireDb(ctx);
  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));

  // The four (workspaceId × afterId) shapes need separate parameter
  // bindings — D1 prepared-statement bindings are positional and a
  // single optional WHERE fragment can't be cleanly omitted.
  let result;
  if (input.workspaceId && input.afterId) {
    result = await db
      .prepare(
        `SELECT id, workspace_id, actor_user_id, action, target_type, target_id,
                metadata_json, created_at
           FROM audit_logs
          WHERE workspace_id = ?1
            AND created_at < (SELECT created_at FROM audit_logs WHERE id = ?2)
          ORDER BY created_at DESC
          LIMIT ?3`,
      )
      .bind(input.workspaceId, input.afterId, limit)
      .all<AuditRow>();
  } else if (input.workspaceId) {
    result = await db
      .prepare(
        `SELECT id, workspace_id, actor_user_id, action, target_type, target_id,
                metadata_json, created_at
           FROM audit_logs
          WHERE workspace_id = ?1
          ORDER BY created_at DESC
          LIMIT ?2`,
      )
      .bind(input.workspaceId, limit)
      .all<AuditRow>();
  } else if (input.afterId) {
    // Instance-admin cross-workspace view, paginated.
    result = await db
      .prepare(
        `SELECT id, workspace_id, actor_user_id, action, target_type, target_id,
                metadata_json, created_at
           FROM audit_logs
          WHERE created_at < (SELECT created_at FROM audit_logs WHERE id = ?1)
          ORDER BY created_at DESC
          LIMIT ?2`,
      )
      .bind(input.afterId, limit)
      .all<AuditRow>();
  } else {
    // Instance-admin cross-workspace view, first page.
    result = await db
      .prepare(
        `SELECT id, workspace_id, actor_user_id, action, target_type, target_id,
                metadata_json, created_at
           FROM audit_logs
          ORDER BY created_at DESC
          LIMIT ?1`,
      )
      .bind(limit)
      .all<AuditRow>();
  }

  // D1's .all() may return either `T[]` or `{ results: T[] }` depending
  // on the runtime (the type union in @vegastack/pages-db covers both).
  const rows: AuditRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);
  return rows.map(rowToRecord);
}
