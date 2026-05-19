import {
  AppError,
  builtinTemplates,
  InMemoryObjectStore,
  R2ObjectStore,
  type ObjectStore,
  type FolderRecord,
  type PageRecord,
  type SearchDocument,
  type SearchResourceType,
  type SearchResult,
  type R2LikeBucket,
  type ObjectStorePutBody,
  type StoredObject,
  type WorkspaceRecord,
} from "@vegastack/pages-core";
import { idPrefixes } from "@vegastack/pages-core";
import { flattenFrontmatter, renderMarkdown } from "@vegastack/pages-renderer";
import {
  pages as pagesService,
  folders as foldersService,
  templates as templatesService,
  audit as auditService,
} from "@vegastack/pages-services";
import {
  agentReviewWorkflowSource,
  demoPageSource,
  mcpSetupSource,
} from "./demo-page";
import { scheduleBackgroundTask } from "./background";
import { buildServiceContext } from "./service-context";
// Node-only adapter types — erased at runtime so the Cloudflare bundle
// never references node:fs/path/sqlite. The runtime symbols
// (FileObjectStore, createNodeSqliteD1) load via the dynamic
// `loadNodeAdapter()` helper below, gated by `isNodeRuntime()`.
import type {
  FileObjectStore as FileObjectStoreClass,
  D1Database,
  D1PreparedStatement,
} from "../adapters/node";

type NodeAdapterModule = typeof import("../adapters/node");
let nodeAdapterModulePromise: Promise<NodeAdapterModule> | null = null;
function loadNodeAdapter(): Promise<NodeAdapterModule> {
  if (!nodeAdapterModulePromise) {
    // The specifier string is built dynamically so Vite/wrangler
    // bundling can't statically include the chunk in the Cloudflare
    // worker output. On Node the require resolves via the standard
    // module loader.
    const specifier = "../adapters/node";
    nodeAdapterModulePromise = import(
      /* @vite-ignore */ specifier
    ) as Promise<NodeAdapterModule>;
  }
  return nodeAdapterModulePromise;
}

export type CloudflareBindings = {
  DB?: D1Database;
  CONTENT?: R2LikeBucket;
  EMAIL?: {
    send(input: unknown): Promise<unknown>;
  };
  AWS_ACCESS_KEY_ID?: string;
  AWS_REGION?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  VPG_EMAIL_FROM?: string;
  VPG_EMAIL_FROM_NAME?: string;
  VPG_EMAIL_PROVIDER?: string;
};

class RuntimeObjectStore implements ObjectStore {
  private r2Store: R2ObjectStore | null = null;
  private fileStore: FileObjectStoreClass | null = null;

  constructor(private readonly fallback: InMemoryObjectStore) {}

  async configure(bucket?: R2LikeBucket | null) {
    if (bucket && !this.r2Store) {
      this.r2Store = new R2ObjectStore(bucket);
    }
    if (!bucket && isNodeRuntime() && !this.fileStore) {
      const { FileObjectStore } = await loadNodeAdapter();
      this.fileStore = new FileObjectStore(
        process.env.VPG_OBJECT_STORE_DIR ?? ".vegastack-pages/objects",
      );
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    return this.r2Store
      ? this.r2Store.get(key)
      : this.fileStore
        ? this.fileStore.get(key)
        : this.fallback.get(key);
  }

  async put(
    key: string,
    body: ObjectStorePutBody,
    options: { contentType?: string } = {},
  ): Promise<StoredObject> {
    return this.r2Store
      ? this.r2Store.put(key, body, options)
      : this.fileStore
        ? this.fileStore.put(key, body, options)
        : this.fallback.put(key, body, options);
  }

  async delete(key: string): Promise<void> {
    return this.r2Store
      ? this.r2Store.delete(key)
      : this.fileStore
        ? this.fileStore.delete(key)
        : this.fallback.delete(key);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return this.r2Store
      ? this.r2Store.list(prefix)
      : this.fileStore
        ? this.fileStore.list(prefix)
        : this.fallback.list(prefix);
  }
}

const fallbackObjectStore = new InMemoryObjectStore();
const objectStore = new RuntimeObjectStore(fallbackObjectStore);

export type McpSessionKind = "manual" | "cli" | "oauth";

export type McpSessionRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  clientName: string;
  protocolVersion: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  kind?: McpSessionKind;
  lastSeenAt?: string | null;
  lastOrigin?: string | null;
  userAgent?: string | null;
  scope?: string | null;
  oauthClientId?: string | null;
};

const fallbackMcpSessions = new Map<string, McpSessionRecord>();
const fallbackRefreshIndex = new Map<string, string>();

let runtimeBindingsPromise: Promise<CloudflareBindings | null> | null = null;
let runtimeReadyPromise: Promise<void> | null = null;
let runtimeD1: D1Database | null = null;

// Per-request D1 batch buffer. AsyncLocalStorage (available on
// Cloudflare via `nodejs_compat`) gives each request its own batch
// array — a module-level `let` would leak statements across concurrent
// requests in the same warm isolate. `d1Run` reads this via
// `getActiveD1Batch()` to decide whether to commit immediately or
// buffer for the surrounding `d1Batch(fn)` caller.
import { AsyncLocalStorage } from "node:async_hooks";
const activeD1BatchStorage = new AsyncLocalStorage<D1PreparedStatement[]>();
function getActiveD1Batch(): D1PreparedStatement[] | null {
  return activeD1BatchStorage.getStore() ?? null;
}
const defaultD1BatchStatementLimit = 1000;

function isNodeRuntime() {
  return process.env.VPG_RUNTIME === "node";
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomBearerToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return `mcp_${btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")}`;
}

async function mcpSessionIdForBearer(rawToken: string): Promise<string> {
  return `mcp_${await sha256Hex(rawToken)}`;
}

// Legacy MCP session IDs (prefix `ses_`) are masked in list responses so
// raw bearer tokens never leak through the management UI. New sessions
// (prefix `mcp_`) are already SHA-256 hashes of the bearer token and
// pass through unchanged.
async function maskListedMcpSession(
  session: McpSessionRecord,
): Promise<McpSessionRecord> {
  if (!session.id.startsWith(`${idPrefixes.session}_`)) return session;
  const masked = `mcp_legacy_${(await sha256Hex(session.id)).slice(0, 32)}`;
  return { ...session, id: masked };
}

function requiresManagedDurableStorage() {
  return (
    process.env.VPG_DEPLOYMENT_MODE === "managed" ||
    process.env.VPG_PUBLIC_SIGNUP === "true"
  );
}

function ephemeralContentAllowed() {
  return process.env.VPG_ALLOW_EPHEMERAL_CONTENT === "true";
}

export function assertRuntimeStorageBindings(input: {
  bindings: Pick<CloudflareBindings, "DB" | "CONTENT"> | null;
  nodeRuntime?: boolean;
}) {
  const nodeRuntime = input.nodeRuntime ?? isNodeRuntime();
  if (
    requiresManagedDurableStorage() &&
    !nodeRuntime &&
    (!input.bindings?.DB || !input.bindings.CONTENT)
  ) {
    throw new Error(
      "Managed hosting requires Cloudflare D1 bound as DB and R2 bound as CONTENT.",
    );
  }
  if (
    !nodeRuntime &&
    input.bindings?.DB &&
    !input.bindings.CONTENT &&
    !ephemeralContentAllowed()
  ) {
    throw new Error(
      "Cloudflare D1 persistence requires R2 bound as CONTENT. Set VPG_ALLOW_EPHEMERAL_CONTENT=true only for disposable test deployments.",
    );
  }
}

export async function getRuntimeBindings(): Promise<CloudflareBindings | null> {
  if (!runtimeBindingsPromise) {
    runtimeBindingsPromise = (async () => {
      const isCloudflareRuntime = process.env.VPG_RUNTIME === "cloudflare";
      if (!isCloudflareRuntime) return null;
      try {
        const specifier = "cloudflare:workers";
        const module = await import(/* @vite-ignore */ specifier);
        return ((module as { env?: CloudflareBindings }).env ??
          null) as CloudflareBindings | null;
      } catch {
        return null;
      }
    })();
  }
  return runtimeBindingsPromise;
}

export function runtimeIsD1(): boolean {
  return runtimeD1 !== null && runtimeD1 !== undefined;
}

export async function d1All<T>(
  query: string,
  ...values: unknown[]
): Promise<T[]> {
  if (!runtimeD1) return [];
  const statement = runtimeD1.prepare(query);
  const rows = await (
    values.length > 0 ? statement.bind(...values) : statement
  ).all<T>();
  return Array.isArray(rows) ? rows : (rows.results ?? []);
}

export async function d1Run(
  query: string,
  ...values: unknown[]
): Promise<void> {
  if (!runtimeD1) return;
  const statement = runtimeD1.prepare(query);
  const prepared = values.length > 0 ? statement.bind(...values) : statement;
  const batch = getActiveD1Batch();
  if (batch) {
    batch.push(prepared);
    return;
  }
  await prepared.run();
}

export async function d1Batch(fn: () => Promise<void>): Promise<void> {
  if (!runtimeD1) return;
  // Nested d1Batch() calls accumulate into the surrounding batch — the
  // outermost call owns the commit.
  if (getActiveD1Batch()) {
    await fn();
    return;
  }

  const statements: D1PreparedStatement[] = [];
  await activeD1BatchStorage.run(statements, async () => {
    await fn();
  });
  if (statements.length === 0) return;

  const maxStatements = d1BatchStatementLimit();
  if (statements.length > maxStatements) {
    throw new AppError(
      "INTERNAL_ERROR",
      "D1 batch would exceed the configured statement cap.",
      500,
      {
        statement_count: statements.length,
        max_statements: maxStatements,
      },
    );
  }

  if (runtimeD1.batch) {
    await runtimeD1.batch(statements);
    return;
  }

  // Fallback transaction path for adapters without a native .batch().
  // We REQUIRE an .exec() implementation here — without it, running
  // statements one-by-one with no BEGIN/COMMIT would silently lose
  // atomicity (mid-batch failure leaves partial writes committed).
  // Throw loudly instead of corrupting state.
  if (typeof runtimeD1.exec !== "function") {
    throw new AppError(
      "INTERNAL_ERROR",
      "D1 adapter exposes neither batch() nor exec(); cannot guarantee atomic multi-statement writes.",
      500,
    );
  }
  await runtimeD1.exec("BEGIN");
  try {
    for (const statement of statements) {
      await statement.run();
    }
    await runtimeD1.exec("COMMIT");
  } catch (error) {
    await runtimeD1.exec("ROLLBACK");
    throw error;
  }
}

function d1BatchStatementLimit() {
  const configured = Number(
    process.env.VPG_D1_MAX_BATCH_STATEMENTS ?? defaultD1BatchStatementLimit,
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : defaultD1BatchStatementLimit;
}

// ---------- runtime bootstrap ----------
//
// With the legacy in-memory singletons removed, "ready" just means
// "bindings asserted + D1 handle resolved + object store configured."
// All persistence flows through the @vegastack/pages-services package
// directly against D1 + R2, so there's no global state to hydrate.

async function initRuntime() {
  const bindings = await getRuntimeBindings();
  assertRuntimeStorageBindings({ bindings });
  await objectStore.configure(bindings?.CONTENT);
  if (bindings?.DB) {
    runtimeD1 = bindings.DB;
  } else if (isNodeRuntime()) {
    const { createNodeSqliteD1 } = await loadNodeAdapter();
    runtimeD1 = await createNodeSqliteD1();
  } else {
    runtimeD1 = null;
  }
}

export async function ensureRuntimeReady() {
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = initRuntime().catch((error) => {
      runtimeReadyPromise = null;
      throw error;
    });
  }
  await runtimeReadyPromise;
}

// Direct-D1 access helpers used by the @vegastack/pages-services
// files. They lazily hydrate the runtime so route handlers can call
// them without manual bootstrap. `getDb()` returns null only when no
// D1 binding is configured (process.env.VPG_RUNTIME=node + no
// node:sqlite available) — services that require D1 throw via
// `requireDb(ctx)` in that case.
export async function getDb(): Promise<D1Database | null> {
  await ensureRuntimeReady();
  return runtimeD1;
}

export async function getObjectStore(): Promise<ObjectStore> {
  await ensureRuntimeReady();
  return objectStore;
}

// ---------- rate limiting ----------

export async function checkRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
}) {
  await ensureRuntimeReady();
  if (!runtimeD1) {
    // No D1 = test/dev fallback. Permit the call; rate limiting only
    // matters in production where D1 is always bound.
    return {
      allowed: true,
      remaining: input.limit,
      resetAt: new Date(Date.now() + input.windowMs).toISOString(),
    };
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const resetAt = new Date(now + input.windowMs).toISOString();
  const next = await runtimeD1
    .prepare(
      [
        "INSERT INTO rate_limits (key, count, reset_at, updated_at)",
        "VALUES (?, 1, ?, ?)",
        "ON CONFLICT(key) DO UPDATE SET",
        "count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,",
        "reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END,",
        "updated_at = excluded.updated_at",
        "RETURNING count, reset_at as resetAt",
      ].join(" "),
    )
    .bind(input.key, resetAt, nowIso, nowIso, nowIso)
    .first<{ count: number; resetAt: string }>();
  if (!next) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Rate limit check did not return an updated counter.",
      500,
    );
  }

  if (next.count > input.limit) {
    throw new AppError(
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      429,
      {
        reset_at: next.resetAt,
      },
    );
  }

  return {
    allowed: true,
    remaining: Math.max(0, input.limit - next.count),
    resetAt: next.resetAt,
  };
}

// ---------- MCP session management ----------

export async function createMcpSession(input: {
  workspaceId: string;
  userId: string;
  clientName?: string;
  protocolVersion?: string | null;
  ttlDays?: number;
  ttlMs?: number;
  kind?: McpSessionKind;
  scope?: string | null;
  refreshTokenHash?: string | null;
  refreshTokenExpiresAt?: string | null;
  userAgent?: string | null;
  lastOrigin?: string | null;
  oauthClientId?: string | null;
}): Promise<{
  session: McpSessionRecord;
  rawToken: string;
  refreshToken: string | null;
}> {
  await ensureRuntimeReady();
  const now = new Date().toISOString();
  const rawToken = randomBearerToken();
  const ttlMs =
    input.ttlMs !== undefined
      ? input.ttlMs
      : (input.ttlDays ?? 30) * 24 * 60 * 60_000;
  const session: McpSessionRecord = {
    id: await mcpSessionIdForBearer(rawToken),
    workspaceId: input.workspaceId,
    userId: input.userId,
    clientName: input.clientName?.trim() || "MCP client",
    protocolVersion: input.protocolVersion ?? null,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    createdAt: now,
    updatedAt: now,
    kind: input.kind ?? "manual",
    lastSeenAt: now,
    lastOrigin: input.lastOrigin ?? null,
    userAgent: input.userAgent ?? null,
    scope: input.scope ?? null,
    oauthClientId: input.oauthClientId ?? null,
  };
  fallbackMcpSessions.set(session.id, session);
  let refreshToken: string | null = null;
  let refreshTokenHash: string | null = input.refreshTokenHash ?? null;
  if (refreshTokenHash === null && input.kind === "oauth") {
    refreshToken = randomBearerToken();
    refreshTokenHash = await mcpSessionIdForBearer(refreshToken);
  }
  if (refreshTokenHash) {
    fallbackRefreshIndex.set(refreshTokenHash, session.id);
  }
  if (runtimeD1) {
    await d1Run(
      "INSERT INTO agent_sessions (id, workspace_id, user_id, client_name, client_version, model, last_seen_at, kind, user_agent, last_origin, oauth_client_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      session.workspaceId,
      session.userId,
      session.clientName,
      null,
      null,
      now,
      session.kind ?? "manual",
      session.userAgent ?? null,
      session.lastOrigin ?? null,
      session.oauthClientId ?? null,
      now,
      now,
    );
    await d1Run(
      "INSERT INTO mcp_sessions (id, workspace_id, user_id, agent_session_id, protocol_version, expires_at, refresh_token_hash, refresh_token_expires_at, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      session.workspaceId,
      session.userId,
      session.id,
      session.protocolVersion,
      session.expiresAt,
      refreshTokenHash,
      input.refreshTokenExpiresAt ?? null,
      session.scope ?? null,
      session.createdAt,
      session.updatedAt,
    );
  }
  return { session, rawToken, refreshToken };
}

export async function findMcpSessionByRefreshToken(
  rawRefreshToken: string,
): Promise<McpSessionRecord | null> {
  await ensureRuntimeReady();
  const hash = await mcpSessionIdForBearer(rawRefreshToken);
  if (runtimeD1) {
    const row = await runtimeD1
      .prepare(
        "SELECT m.id, m.workspace_id as workspaceId, m.user_id as userId, COALESCE(a.client_name, 'MCP client') as clientName, m.protocol_version as protocolVersion, m.expires_at as expiresAt, m.refresh_token_expires_at as refreshTokenExpiresAt, a.kind as kind, m.scope as scope, m.created_at as createdAt, m.updated_at as updatedAt FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id WHERE m.refresh_token_hash = ?",
      )
      .bind(hash)
      .first<McpSessionRecord & { refreshTokenExpiresAt: string | null }>();
    if (row) {
      if (
        row.refreshTokenExpiresAt &&
        Date.parse(row.refreshTokenExpiresAt) <= Date.now()
      ) {
        return null;
      }
      return row;
    }
  }
  const sessionId = fallbackRefreshIndex.get(hash);
  if (!sessionId) return null;
  const session = fallbackMcpSessions.get(sessionId);
  return session ?? null;
}

export async function listMcpSessions(input: {
  workspaceId: string;
  userId?: string;
}): Promise<McpSessionRecord[]> {
  await ensureRuntimeReady();
  const now = new Date().toISOString();
  if (runtimeD1) {
    const rows = await d1All<McpSessionRecord>(
      "SELECT m.id, m.workspace_id as workspaceId, m.user_id as userId, COALESCE(a.client_name, 'MCP client') as clientName, m.protocol_version as protocolVersion, m.expires_at as expiresAt, m.created_at as createdAt, m.updated_at as updatedAt, COALESCE(a.kind, 'manual') as kind, a.last_seen_at as lastSeenAt, a.last_origin as lastOrigin, a.user_agent as userAgent, m.scope as scope, a.oauth_client_id as oauthClientId FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id WHERE m.workspace_id = ? AND m.expires_at > ? ORDER BY m.created_at DESC",
      input.workspaceId,
      now,
    );
    const filtered = input.userId
      ? rows.filter((session) => session.userId === input.userId)
      : rows;
    return Promise.all(
      filtered.map((session) => maskListedMcpSession(session)),
    );
  }
  const sessions = [...fallbackMcpSessions.values()]
    .filter(
      (session) =>
        session.workspaceId === input.workspaceId && session.expiresAt > now,
    )
    .filter((session) => !input.userId || session.userId === input.userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return Promise.all(sessions.map((session) => maskListedMcpSession(session)));
}

export async function getMcpSession(
  rawToken: string,
): Promise<McpSessionRecord | null> {
  await ensureRuntimeReady();
  const hashedSessionId = await mcpSessionIdForBearer(rawToken);
  const selectColumns =
    "m.id, m.workspace_id as workspaceId, m.user_id as userId, COALESCE(a.client_name, 'MCP client') as clientName, m.protocol_version as protocolVersion, m.expires_at as expiresAt, m.created_at as createdAt, m.updated_at as updatedAt, COALESCE(a.kind, 'manual') as kind, a.last_seen_at as lastSeenAt, a.last_origin as lastOrigin, a.user_agent as userAgent, m.scope as scope, a.oauth_client_id as oauthClientId";
  if (runtimeD1) {
    const row = await runtimeD1
      .prepare(
        `SELECT ${selectColumns} FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id WHERE m.id = ?`,
      )
      .bind(hashedSessionId)
      .first<McpSessionRecord>();
    if (row && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now()))
      return row;
    const legacyRow = await runtimeD1
      .prepare(
        `SELECT ${selectColumns} FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id WHERE m.id = ?`,
      )
      .bind(rawToken)
      .first<McpSessionRecord>();
    if (
      !legacyRow ||
      (legacyRow.expiresAt && Date.parse(legacyRow.expiresAt) <= Date.now())
    )
      return null;
    return legacyRow;
  }
  const session =
    fallbackMcpSessions.get(hashedSessionId) ??
    fallbackMcpSessions.get(rawToken);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  return session;
}

export async function revokeMcpSession(input: {
  sessionId: string;
  workspaceId: string;
}): Promise<boolean> {
  await ensureRuntimeReady();
  if (runtimeD1) {
    const sessionId = await resolveStoredMcpSessionId(input);
    const existing = await runtimeD1
      .prepare("SELECT id FROM mcp_sessions WHERE id = ? AND workspace_id = ?")
      .bind(sessionId, input.workspaceId)
      .first<{ id: string }>();
    if (!existing) return false;
    // Both rows must be removed atomically: if the second DELETE fails,
    // the first should not have committed (otherwise `agent_sessions`
    // lingers as an orphan with no parent mcp_session).
    await d1Batch(async () => {
      await d1Run(
        "DELETE FROM mcp_sessions WHERE id = ? AND workspace_id = ?",
        sessionId,
        input.workspaceId,
      );
      await d1Run("DELETE FROM agent_sessions WHERE id = ?", sessionId);
    });
    return true;
  }
  const sessionId = await resolveStoredMcpSessionId(input);
  const session = fallbackMcpSessions.get(sessionId);
  if (!session || session.workspaceId !== input.workspaceId) return false;
  fallbackMcpSessions.delete(sessionId);
  return true;
}

async function resolveStoredMcpSessionId(input: {
  sessionId: string;
  workspaceId: string;
}) {
  if (!input.sessionId.startsWith("mcp_legacy_")) return input.sessionId;
  const sessions = runtimeD1
    ? await d1All<{ id: string }>(
        "SELECT id FROM mcp_sessions WHERE workspace_id = ?",
        input.workspaceId,
      )
    : [...fallbackMcpSessions.values()]
        .filter((session) => session.workspaceId === input.workspaceId)
        .map((session) => ({ id: session.id }));
  for (const session of sessions) {
    const maskedId = `mcp_legacy_${(await sha256Hex(session.id)).slice(0, 32)}`;
    if (maskedId === input.sessionId) {
      return session.id;
    }
  }
  return input.sessionId;
}

// ---------- search indexing ----------
//
// Background-task indexers: routes call scheduleIndexPage/Folder/Thread
// after a mutation; the scheduler queues the actual D1 + searchService
// writes off the request path. All lookups go directly against D1.

function normalizeFtsQuery(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/["*^:(){}[\]]/g, " ").trim())
    .filter(Boolean)
    .map((part) => `"${part.replaceAll('"', '""')}"*`)
    .join(" ");
}

async function indexSearchDocument(document: SearchDocument) {
  if (!runtimeD1) return;
  if (!(await searchDocumentParentExists(document))) return;
  await d1Batch(async () => {
    await d1Run(
      "INSERT INTO search_documents (resource_type, resource_id, workspace_id, page_id, folder_id, title, path, headings_text, frontmatter_text, body_text, comment_text, tags, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(resource_type, resource_id) DO UPDATE SET workspace_id = excluded.workspace_id, page_id = excluded.page_id, folder_id = excluded.folder_id, title = excluded.title, path = excluded.path, headings_text = excluded.headings_text, frontmatter_text = excluded.frontmatter_text, body_text = excluded.body_text, comment_text = excluded.comment_text, tags = excluded.tags, url = excluded.url, updated_at = excluded.updated_at",
      document.type,
      document.id,
      document.workspaceId,
      document.pageId ?? null,
      document.folderId ?? null,
      document.title,
      document.path,
      document.headingsText ?? "",
      document.frontmatterText ?? "",
      document.bodyText ?? "",
      document.commentText ?? "",
      document.tags ?? "",
      document.url,
      document.updatedAt,
    );
    await d1Run(
      "DELETE FROM search_documents_fts WHERE resource_type = ? AND resource_id = ?",
      document.type,
      document.id,
    );
    await d1Run(
      "INSERT INTO search_documents_fts (resource_type, resource_id, workspace_id, page_id, folder_id, title, path, headings_text, frontmatter_text, body_text, comment_text, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      document.type,
      document.id,
      document.workspaceId,
      document.pageId ?? null,
      document.folderId ?? null,
      document.title,
      document.path,
      document.headingsText ?? "",
      document.frontmatterText ?? "",
      document.bodyText ?? "",
      document.commentText ?? "",
      document.tags ?? "",
    );
  });
}

async function searchDocumentParentExists(document: SearchDocument) {
  if (!runtimeD1) return false;
  if (document.type === "page") {
    return Boolean(
      await runtimeD1
        .prepare("SELECT 1 FROM pages WHERE id = ?")
        .bind(document.id)
        .first(),
    );
  }
  if (document.type === "folder") {
    return Boolean(
      await runtimeD1
        .prepare("SELECT 1 FROM folders WHERE id = ?")
        .bind(document.id)
        .first(),
    );
  }
  return Boolean(
    await runtimeD1
      .prepare("SELECT 1 FROM comment_threads WHERE id = ?")
      .bind(document.id)
      .first(),
  );
}

function folderSearchDocument(folder: FolderRecord): SearchDocument {
  return {
    type: "folder",
    id: folder.id,
    workspaceId: folder.workspaceId,
    pageId: null,
    folderId: folder.id,
    title: folder.name,
    path: folder.path,
    bodyText: "",
    commentText: "",
    tags: "folder",
    url: `/f/${folder.slugId}`,
    updatedAt: folder.updatedAt,
  };
}

type PageIndexRow = {
  id: string;
  workspaceId: string;
  folderId: string | null;
  title: string;
  slugId: string;
  sourceType: "markdown" | "mdx" | "html";
  objectKeyCurrent: string;
  updatedAt: string;
};

async function pageSearchDocument(
  pageId: string,
): Promise<SearchDocument | null> {
  if (!runtimeD1) return null;
  const page = await runtimeD1
    .prepare(
      "SELECT id, workspace_id as workspaceId, folder_id as folderId, title, slug_id as slugId, source_type as sourceType, object_key_current as objectKeyCurrent, updated_at as updatedAt FROM pages WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(pageId)
    .first<PageIndexRow>();
  if (!page) return null;
  let folderPath = "";
  if (page.folderId) {
    const folder = await runtimeD1
      .prepare("SELECT path FROM folders WHERE id = ?")
      .bind(page.folderId)
      .first<{ path: string }>();
    folderPath = folder?.path ?? "";
  }
  const stored = await objectStore.get(page.objectKeyCurrent);
  const source = stored?.body ?? "";
  const rendered =
    page.sourceType === "html" ? null : await renderMarkdown(source);
  const htmlText = page.sourceType === "html" ? htmlToSearchText(source) : null;
  return {
    type: "page",
    id: page.id,
    workspaceId: page.workspaceId,
    pageId: page.id,
    folderId: page.folderId,
    title: page.title,
    path: folderPath ? `${folderPath}/${page.title}` : page.title,
    headingsText:
      htmlText?.headings ??
      rendered?.headings.map((heading) => heading.text).join("\n") ??
      "",
    frontmatterText: rendered ? flattenFrontmatter(rendered.frontmatter) : "",
    bodyText: htmlText?.body ?? rendered?.plainText ?? "",
    commentText: "",
    tags: "page document",
    url: `/p/${page.slugId}`,
    updatedAt: page.updatedAt,
  };
}

function htmlToSearchText(source: string) {
  const withoutActiveContent = source
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ");
  const headings = [
    ...withoutActiveContent.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi),
  ]
    .map((match) => htmlTextContent(match[1] ?? ""))
    .filter(Boolean)
    .join("\n");
  return {
    headings,
    body: htmlTextContent(withoutActiveContent),
  };
}

function htmlTextContent(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function commentThreadSearchDocument(
  threadId: string,
): Promise<SearchDocument | null> {
  if (!runtimeD1) return null;
  const thread = await runtimeD1
    .prepare(
      "SELECT t.id, t.workspace_id as workspaceId, t.page_id as pageId, t.status, t.selected_text as selectedText, t.updated_at as updatedAt, p.folder_id as folderId, p.title as pageTitle, p.slug_id as pageSlugId, f.path as folderPath FROM comment_threads t JOIN pages p ON p.id = t.page_id AND p.deleted_at IS NULL LEFT JOIN folders f ON f.id = p.folder_id WHERE t.id = ?",
    )
    .bind(threadId)
    .first<{
      id: string;
      workspaceId: string;
      pageId: string;
      status: string;
      selectedText: string;
      updatedAt: string;
      folderId: string | null;
      pageTitle: string;
      pageSlugId: string;
      folderPath: string | null;
    }>();
  if (!thread) return null;
  const replies = await d1All<{ body: string }>(
    "SELECT body FROM comment_replies WHERE thread_id = ? ORDER BY created_at",
    thread.id,
  );
  const commentText = [
    thread.selectedText,
    ...replies.map((reply) => reply.body),
  ]
    .filter(Boolean)
    .join("\n");
  const folderPath = thread.folderPath ?? "";
  return {
    type: "comment_thread",
    id: thread.id,
    workspaceId: thread.workspaceId,
    pageId: thread.pageId,
    folderId: thread.folderId,
    title: `Comment on ${thread.pageTitle}`,
    path: folderPath ? `${folderPath}/${thread.pageTitle}` : thread.pageTitle,
    bodyText: thread.selectedText,
    commentText,
    tags: `comment thread ${thread.status}`,
    url: `/p/${thread.pageSlugId}?thread_id=${encodeURIComponent(thread.id)}`,
    updatedAt: thread.updatedAt,
  };
}

export async function indexFolder(folderId: string) {
  await ensureRuntimeReady();
  if (!runtimeD1) return;
  const folder = await runtimeD1
    .prepare(
      "SELECT id, workspace_id as workspaceId, parent_folder_id as parentFolderId, name, slug, slug_id as slugId, path, position, created_at as createdAt, updated_at as updatedAt FROM folders WHERE id = ?",
    )
    .bind(folderId)
    .first<FolderRecord>();
  if (!folder) return;
  const document = folderSearchDocument(folder);
  await indexSearchDocument(document);
}

export function scheduleIndexFolder(folderId: string) {
  scheduleBackgroundTask("indexFolder", () => indexFolder(folderId));
}

export async function indexCommentThread(threadId: string) {
  await ensureRuntimeReady();
  const document = await commentThreadSearchDocument(threadId);
  if (!document) return;
  await indexSearchDocument(document);
}

export function scheduleIndexCommentThread(threadId: string) {
  scheduleBackgroundTask("indexCommentThread", () =>
    indexCommentThread(threadId),
  );
}

export async function indexPage(pageId: string) {
  await ensureRuntimeReady();
  const document = await pageSearchDocument(pageId);
  if (!document) return;
  await indexSearchDocument(document);
}

export function scheduleIndexPage(pageId: string) {
  scheduleBackgroundTask("indexPage", () => indexPage(pageId));
}

export async function removeSearchResource(
  type: SearchResourceType,
  id: string,
) {
  await ensureRuntimeReady();
  if (!runtimeD1) return;
  // FTS5 + base rows must be removed atomically — otherwise a failure
  // between the two leaves an FTS index entry pointing at a missing
  // base row (or vice-versa), corrupting search.
  await d1Batch(async () => {
    await d1Run(
      "DELETE FROM search_documents_fts WHERE resource_type = ? AND resource_id = ?",
      type,
      id,
    );
    await d1Run(
      "DELETE FROM search_documents WHERE resource_type = ? AND resource_id = ?",
      type,
      id,
    );
  });
}

export async function searchIndexedResources(
  workspaceId: string,
  query: string,
  input: {
    limit?: number;
    type?: SearchResourceType | "all";
    favoritePageIds?: Set<string>;
    recentResourceIds?: Set<string>;
  } = {},
): Promise<SearchResult[]> {
  await ensureRuntimeReady();
  const limit = input.limit ?? 10;
  const type = input.type ?? "all";
  const ftsQuery = normalizeFtsQuery(query);
  if (!runtimeD1 || !ftsQuery) return [];
  const typeClause = type === "all" ? "" : " AND d.resource_type = ?";
  const rows = await runtimeD1
    .prepare(
      `SELECT d.resource_type as type, d.resource_id as id, d.page_id as pageId, d.folder_id as folderId, d.title as title, d.url as url, d.path as path, d.path as subtitle, d.updated_at as updatedAt, snippet(search_documents_fts, -1, '', '', '...', 24) as snippet, CASE d.resource_type WHEN 'folder' THEN 'folder' WHEN 'comment_thread' THEN 'message-square' ELSE 'file-text' END as icon, CASE WHEN instr(lower(d.title), lower(?)) > 0 THEN 'title' WHEN instr(lower(d.path), lower(?)) > 0 THEN 'path' WHEN instr(lower(d.comment_text), lower(?)) > 0 THEN 'comment' ELSE 'content' END as matchedField, -rank as score FROM search_documents_fts JOIN search_documents d ON d.resource_type = search_documents_fts.resource_type AND d.resource_id = search_documents_fts.resource_id WHERE search_documents_fts.workspace_id = ? AND search_documents_fts MATCH ?${typeClause} ORDER BY rank, d.updated_at DESC LIMIT ?`,
    )
    .bind(
      query,
      query,
      query,
      workspaceId,
      ftsQuery,
      ...(type === "all" ? [] : [type]),
      limit,
    )
    .all<SearchResult>();
  return Array.isArray(rows) ? rows : (rows.results ?? []);
}

export async function searchIndexedPages(
  workspaceId: string,
  query: string,
  limit = 10,
): Promise<SearchResult[]> {
  return searchIndexedResources(workspaceId, query, { limit, type: "page" });
}

export async function recordSearchResourceOpen(input: {
  userId: string | null;
  workspaceId: string;
  type: SearchResourceType;
  id: string;
}) {
  await ensureRuntimeReady();
  if (!runtimeD1 || !input.userId) return;
  const now = new Date().toISOString();
  await d1Run(
    "INSERT INTO search_recent_resources (user_id, workspace_id, resource_type, resource_id, last_opened_at, open_count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET workspace_id = excluded.workspace_id, last_opened_at = excluded.last_opened_at, open_count = search_recent_resources.open_count + 1",
    input.userId,
    input.workspaceId,
    input.type,
    input.id,
    now,
  );
}

export async function listRecentSearchResources(input: {
  userId: string | null;
  workspaceId: string;
  limit?: number;
}): Promise<SearchResult[]> {
  await ensureRuntimeReady();
  if (!runtimeD1 || !input.userId) return [];
  const rows = await runtimeD1
    .prepare(
      "SELECT d.resource_type as type, d.resource_id as id, d.page_id as pageId, d.folder_id as folderId, d.title as title, d.url as url, d.path as path, d.path as subtitle, d.updated_at as updatedAt, substr(COALESCE(NULLIF(d.comment_text, ''), NULLIF(d.body_text, ''), d.path), 1, 160) as snippet, CASE d.resource_type WHEN 'folder' THEN 'folder' WHEN 'comment_thread' THEN 'message-square' ELSE 'file-text' END as icon, 'title' as matchedField, r.open_count as score FROM search_recent_resources r JOIN search_documents d ON d.resource_type = r.resource_type AND d.resource_id = r.resource_id WHERE r.user_id = ? AND r.workspace_id = ? ORDER BY r.last_opened_at DESC LIMIT ?",
    )
    .bind(input.userId, input.workspaceId, input.limit ?? 8)
    .all<SearchResult>();
  return Array.isArray(rows) ? rows : (rows.results ?? []);
}

// ---------- workspace seeding ----------

const seedPages = [
  {
    title: "Get Started",
    folderPath: "",
    source: demoPageSource,
  },
  {
    title: "Agent Review Workflow",
    folderPath: "guides",
    source: agentReviewWorkflowSource,
  },
  {
    title: "MCP Setup",
    folderPath: "guides",
    source: mcpSetupSource,
  },
];

type WorkspaceSeedResult = {
  workspace: WorkspaceRecord;
  firstPageSlugId: string;
  pageIds: string[];
};

export async function seedBuiltinTemplates(input: {
  workspaceId: string;
  actorUserId?: string | null;
}): Promise<{ created: number; existing: number }> {
  await ensureRuntimeReady();
  const { ctx } = await buildServiceContext({
    workspaceId: input.workspaceId,
  });
  let created = 0;
  let existing = 0;
  for (const spec of builtinTemplates) {
    const existingTemplate = await templatesService.getBySlug(ctx, {
      workspaceId: input.workspaceId,
      slug: spec.slug,
    });
    if (existingTemplate) {
      existing += 1;
      continue;
    }
    await templatesService.create(ctx, {
      workspaceId: input.workspaceId,
      slug: spec.slug,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      source: spec.body,
      sourceType: "markdown",
      properties: spec.properties,
      isBuiltin: true,
    });
    created += 1;
  }
  return { created, existing };
}

export async function seedWorkspace(input: {
  workspaceId: string;
  actorUserId?: string | null;
}): Promise<WorkspaceSeedResult> {
  await ensureRuntimeReady();
  const { ctx } = await buildServiceContext({
    workspaceId: input.workspaceId,
  });

  // Look up the workspace from D1. Throws NOT_FOUND if missing — same
  // behavior as the legacy seed which checked workspaceService.getWorkspace.
  const workspace: WorkspaceRecord = await (async () => {
    if (!runtimeD1) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }
    const row = await runtimeD1
      .prepare(
        "SELECT id, name, slug, version_retention_days as versionRetentionDays, created_at as createdAt, updated_at as updatedAt FROM workspaces WHERE id = ?",
      )
      .bind(input.workspaceId)
      .first<WorkspaceRecord>();
    if (!row) throw new Error(`Workspace not found: ${input.workspaceId}`);
    return row;
  })();

  // Ensure the two default folders exist (idempotent — skip if a folder
  // already lives at that path).
  const existingFolders = await foldersService.listAll(ctx, {
    workspaceId: workspace.id,
  });
  if (!existingFolders.some((folder) => folder.path === "guides")) {
    await foldersService.create(ctx, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: "Guides",
      position: 1,
    });
  }
  if (!existingFolders.some((folder) => folder.path === "agents")) {
    await foldersService.create(ctx, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: "Agents",
      position: 2,
    });
  }

  // Pages: if any exist, reuse them. Otherwise create the demo set.
  const existingPages = await pagesService.list(ctx, workspace.id);
  let pages: PageRecord[];
  if (existingPages.length > 0) {
    pages = existingPages;
  } else {
    const created: PageRecord[] = [];
    for (const seedPage of seedPages) {
      const result = await pagesService.create(ctx, {
        workspaceId: workspace.id,
        folderPath: seedPage.folderPath,
        title: seedPage.title,
        sourceType: "markdown",
        source: seedPage.source,
      });
      created.push(result.data.page);
    }
    pages = created;
  }

  await seedBuiltinTemplates({
    workspaceId: workspace.id,
    actorUserId: input.actorUserId ?? null,
  });

  // Audit "workspace.seeded" once per workspace.
  const priorAudit = await auditService.list(ctx, {
    workspaceId: workspace.id,
    limit: 200,
  });
  if (!priorAudit.some((log) => log.action === "workspace.seeded")) {
    await auditService.record(ctx, {
      workspaceId: workspace.id,
      actorUserId: input.actorUserId ?? null,
      action: "workspace.seeded",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { page_ids: pages.map((page) => page.id) },
    });
  }

  // Re-index the seeded pages and folders so search results are
  // available immediately after signup/setup.
  for (const folder of await foldersService.listAll(ctx, {
    workspaceId: workspace.id,
  })) {
    await indexFolder(folder.id);
  }
  for (const page of pages) {
    await indexPage(page.id);
  }

  return {
    workspace,
    firstPageSlugId: pages[0]?.slugId ?? "get-started-a8f31c000000",
    pageIds: pages.map((page) => page.id),
  };
}
