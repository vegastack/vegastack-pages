import {
  AttachmentService,
  AuditService,
  AuthService,
  AppError,
  builtinTemplates,
  CommentService,
  FavoriteService,
  InMemoryObjectStore,
  R2ObjectStore,
  PageService,
  PermissionService,
  RateLimiter,
  ReviewEventService,
  SearchService,
  SetupService,
  PublicationService,
  TemplateService,
  WorkspaceService,
  type ObjectStore,
  type AttachmentRecord,
  type AuditLogRecord,
  type CommentAnchorRecord,
  type CommentReplyRecord,
  type CommentThreadRecord,
  type FolderRecord,
  type FavoriteRecord,
  type MagicLinkRecord,
  type PageRecord,
  type PageVersionRecord,
  type PermissionRecord,
  type ReviewEventRecord,
  type SearchDocument,
  type SearchResourceType,
  type SearchResult,
  type SessionRecord,
  type R2LikeBucket,
  type PublicationRecord,
  type SetupState,
  type TemplateProperty,
  type TemplateRecord,
  type TemplateVersionRecord,
  type UserRecord,
  type WorkspaceMemberRecord,
  type StoredObject,
  type WorkspaceRecord,
} from "@vegastack/pages-core";
import { idPrefixes } from "@vegastack/pages-core";
import { flattenFrontmatter, renderMarkdown } from "@vegastack/pages-renderer";
import {
  agentReviewWorkflowSource,
  demoPageSource,
  mcpSetupSource,
} from "./demo-page";

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] } | T[]>;
  run(): Promise<unknown>;
};

type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
};

type CloudflareBindings = {
  DB?: D1Database;
  CONTENT?: R2LikeBucket;
  EMAIL?: {
    send(input: unknown): Promise<unknown>;
  };
};

type RuntimeSnapshot = {
  version: 1;
  setupState: SetupState;
  pageService: Record<string, unknown>;
  workspaceService: Record<string, unknown>;
  permissionService: Record<string, unknown>;
  authService: Record<string, unknown>;
  commentService: Record<string, unknown>;
  publicationService: Record<string, unknown>;
  searchService: Record<string, unknown>;
  attachmentService: Record<string, unknown>;
  favoriteService?: Record<string, unknown>;
  auditService: Record<string, unknown>;
  reviewEventService: Record<string, unknown>;
  templateService: Record<string, unknown>;
};

class RuntimeObjectStore implements ObjectStore {
  private r2Store: R2ObjectStore | null = null;
  private fileStore: FileObjectStore | null = null;

  constructor(private readonly fallback: InMemoryObjectStore) {}

  async configure(bucket?: R2LikeBucket | null) {
    if (bucket && !this.r2Store) {
      this.r2Store = new R2ObjectStore(bucket);
    }
    if (!bucket && isNodeRuntime() && !this.fileStore) {
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
    body: string,
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

class FileObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private async modules() {
    const fsSpecifier = "node:fs/promises";
    const pathSpecifier = "node:path";
    const fs = await import(/* @vite-ignore */ fsSpecifier);
    const path = await import(/* @vite-ignore */ pathSpecifier);
    return { fs, path };
  }

  private async filePath(key: string) {
    const { fs, path } = await this.modules();
    const root = path.resolve(this.root);
    const target = path.resolve(root, key);
    if (!target.startsWith(root + path.sep) && target !== root) {
      throw new Error("Object key escapes object store root.");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    return target;
  }

  async get(key: string): Promise<StoredObject | null> {
    const { fs } = await this.modules();
    const file = await this.filePath(key);
    try {
      const [body, meta] = await Promise.all([
        fs.readFile(file, "utf8"),
        fs.readFile(`${file}.meta.json`, "utf8").catch(() => "{}"),
      ]);
      const parsed = JSON.parse(meta) as {
        contentType?: string;
        updatedAt?: string;
      };
      return {
        key,
        body,
        contentType: parsed.contentType ?? "application/octet-stream",
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(
    key: string,
    body: string,
    options: { contentType?: string } = {},
  ): Promise<StoredObject> {
    const { fs } = await this.modules();
    const file = await this.filePath(key);
    const stored: StoredObject = {
      key,
      body,
      contentType: options.contentType ?? "application/octet-stream",
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(file, body, "utf8");
    await fs.writeFile(
      `${file}.meta.json`,
      JSON.stringify({
        contentType: stored.contentType,
        updatedAt: stored.updatedAt,
      }),
      "utf8",
    );
    return stored;
  }

  async delete(key: string): Promise<void> {
    const { fs } = await this.modules();
    const file = await this.filePath(key);
    await Promise.all([
      fs.rm(file, { force: true }),
      fs.rm(`${file}.meta.json`, { force: true }),
    ]);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const { fs, path } = await this.modules();
    const root = path.resolve(this.root);
    const start = path.resolve(root, prefix);
    const files: string[] = [];
    async function walk(dir: string) {
      const entries = await fs
        .readdir(dir, { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (!entry.name.endsWith(".meta.json")) {
          files.push(full);
        }
      }
    }
    await walk(start);
    const objects = await Promise.all(
      files.map((file) => this.get(path.relative(root, file))),
    );
    return objects.filter((object): object is StoredObject => Boolean(object));
  }
}

class NodeSqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: {
      prepare(query: string): {
        get(...values: unknown[]): unknown;
        all(...values: unknown[]): unknown[];
        run(...values: unknown[]): unknown;
      };
    },
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new NodeSqlitePreparedStatement(this.database, this.query, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    return (
      (this.database.prepare(this.query).get(...this.values) as
        | T
        | undefined) ?? null
    );
  }

  async all<T = unknown>(): Promise<{ results?: T[] } | T[]> {
    return this.database.prepare(this.query).all(...this.values) as T[];
  }

  async run(): Promise<unknown> {
    return this.database.prepare(this.query).run(...this.values);
  }
}

class NodeSqliteD1Database implements D1Database {
  constructor(
    private readonly database: {
      exec(query: string): unknown;
      prepare(query: string): {
        get(...values: unknown[]): unknown;
        all(...values: unknown[]): unknown[];
        run(...values: unknown[]): unknown;
      };
    },
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new NodeSqlitePreparedStatement(this.database, query);
  }

  async exec(query: string): Promise<unknown> {
    return this.database.exec(query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    if (statements.length === 0) return [];
    this.database.exec("BEGIN");
    try {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const fallbackObjectStore = new InMemoryObjectStore();
const objectStore = new RuntimeObjectStore(fallbackObjectStore);
export const pageService = new PageService(objectStore);
export const setupService = new SetupService();
export const commentService = new CommentService();
export const publicationService = new PublicationService();
export const searchService = new SearchService();
export const workspaceService = new WorkspaceService();
export const permissionService = new PermissionService();
export const authService = new AuthService();
export const attachmentService = new AttachmentService(objectStore);
export const favoriteService = new FavoriteService();
export const auditService = new AuditService();
export const reviewEventService = new ReviewEventService();
export const templateService = new TemplateService(objectStore);

export const rateLimiter = new RateLimiter();

export type McpSessionRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  clientName: string;
  protocolVersion: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type AuthIdentityRow = {
  id: string;
  userId: string;
  provider: string;
  providerSubject: string;
  email: string;
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  workspaceId: string | null;
  type: string;
  status: string;
  payloadJson: string;
  resultJson: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
};

type GitHubSyncConnectionRow = {
  id: string;
  workspaceId: string;
  installationId: number;
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  branch: string | null;
  rootPath: string;
  includeAssets: boolean | number;
  enabled: boolean | number;
  lastStatus: string;
  lastSyncedAt: string | null;
  lastCommitSha: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type GitHubSyncRunRow = {
  id: string;
  connectionId: string;
  workspaceId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  baseCommitSha: string | null;
  headCommitSha: string | null;
  pagesWritten: number;
  templatesWritten: number;
  assetsWritten: number;
  filesDeleted: number;
  errorJson: string | null;
};

const fallbackMcpSessions = new Map<string, McpSessionRecord>();

let runtimeBindingsPromise: Promise<CloudflareBindings | null> | null = null;
let runtimeReadyPromise: Promise<void> | null = null;
let runtimeD1: D1Database | null = null;
let runtimeHydratedFromNormalizedTables = false;
let activeD1Batch: D1PreparedStatement[] | null = null;
const defaultD1BatchStatementLimit = 1000;

function isNodeRuntime() {
  return (
    process.env.VPG_ADAPTER === "node" || process.env.VPG_RUNTIME === "node"
  );
}

async function sha256Hex(input: string): Promise<string> {
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

async function legacyMcpSessionListId(sessionId: string): Promise<string> {
  return `mcp_legacy_${(await sha256Hex(sessionId)).slice(0, 32)}`;
}

async function maskListedMcpSession(
  session: McpSessionRecord,
): Promise<McpSessionRecord> {
  if (!session.id.startsWith(`${idPrefixes.session}_`)) return session;
  return { ...session, id: await legacyMcpSessionListId(session.id) };
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
      const isCloudflareRuntime =
        process.env.VPG_ADAPTER === "cloudflare" ||
        process.env.VPG_RUNTIME === "cloudflare" ||
        process.env.CF_PAGES === "1";
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

function mapEntries<T>(service: unknown, key: string): [string, T][] {
  const value = (service as Record<string, unknown>)[key];
  return value instanceof Map ? ([...value.entries()] as [string, T][]) : [];
}

function arrayValue<T>(service: unknown, key: string): T[] {
  const value = (service as Record<string, unknown>)[key];
  return Array.isArray(value) ? ([...value] as T[]) : [];
}

function restoreMap<T>(
  service: unknown,
  key: string,
  entries: [string, T][] | undefined,
) {
  const value = (service as Record<string, unknown>)[key];
  if (!(value instanceof Map)) return;
  value.clear();
  for (const [entryKey, entryValue] of entries ?? []) {
    value.set(entryKey, entryValue);
  }
}

function restoreArray<T>(
  service: unknown,
  key: string,
  values: T[] | undefined,
) {
  const value = (service as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return;
  value.splice(0, value.length, ...(values ?? []));
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
  if (activeD1Batch) {
    activeD1Batch.push(prepared);
    return;
  }
  await prepared.run();
}

export async function d1Batch(fn: () => Promise<void>): Promise<void> {
  if (!runtimeD1) return;
  if (activeD1Batch) {
    await fn();
    return;
  }

  activeD1Batch = [];
  try {
    await fn();
    const statements = activeD1Batch;
    activeD1Batch = null;
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

    await runtimeD1.exec?.("BEGIN");
    try {
      for (const statement of statements) {
        await statement.run();
      }
      await runtimeD1.exec?.("COMMIT");
    } catch (error) {
      await runtimeD1.exec?.("ROLLBACK");
      throw error;
    }
  } catch (error) {
    activeD1Batch = null;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boolFromDb(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function jsonFromDb(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function jsonToDb(value: Record<string, unknown>): string {
  return JSON.stringify(value ?? {});
}

function normalizeCommentAnchorRecord(
  anchor: CommentAnchorRecord,
): CommentAnchorRecord {
  const raw = anchor as unknown as {
    kind?: unknown;
    selector?: unknown;
  };
  const selector =
    raw.selector && typeof raw.selector === "object"
      ? (raw.selector as Record<string, unknown>)
      : null;
  const legacyRect =
    selector?.rect && typeof selector.rect === "object"
      ? (selector.rect as Record<string, unknown>)
      : null;

  if (raw.kind === "point" && !legacyRect) return anchor;
  if (raw.kind === "text" && !legacyRect) return anchor;

  if (raw.kind === "rect" || legacyRect) {
    return {
      ...anchor,
      selectedText:
        anchor.selectedText && anchor.selectedText !== "Selected area"
          ? anchor.selectedText
          : "Pinned comment",
      kind: "point",
      selector: {
        point: {
          x: clamp01(
            numberFromUnknown(legacyRect?.x, 0.5) +
              numberFromUnknown(legacyRect?.width, 0) / 2,
          ),
          y: clamp01(
            numberFromUnknown(legacyRect?.y, 0.05) +
              numberFromUnknown(legacyRect?.height, 0) / 2,
          ),
          coordinateSpace:
            legacyRect?.coordinateSpace === "element" ? "element" : "document",
          elementPath: legacyRect?.elementPath
            ? String(legacyRect.elementPath)
            : null,
        },
      },
      confidence: anchor.confidence ?? "manual",
    };
  }

  return { ...anchor, kind: "text", selector: null };
}

function numberFromUnknown(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function serviceMapValues<T>(service: unknown, key: string): T[] {
  const value = (service as Record<string, unknown>)[key];
  return value instanceof Map ? ([...value.values()] as T[]) : [];
}

function serviceArrayValues<T>(service: unknown, key: string): T[] {
  const value = (service as Record<string, unknown>)[key];
  return Array.isArray(value) ? ([...value] as T[]) : [];
}

function folderIdForPath(
  workspaceId: string,
  folderPath: string,
): string | null {
  if (!folderPath) return null;
  return (
    workspaceService
      .listFolders(workspaceId)
      .find((folder) => folder.path === folderPath)?.id ?? null
  );
}

function createRuntimeSnapshot(): RuntimeSnapshot {
  return {
    version: 1,
    setupState: setupService.status(),
    pageService: {
      pages: mapEntries(pageService, "pages"),
      pagesByShortId: mapEntries(pageService, "pagesByShortId"),
      versions: mapEntries(pageService, "versions"),
    },
    workspaceService: {
      users: mapEntries(workspaceService, "users"),
      usersByEmail: mapEntries(workspaceService, "usersByEmail"),
      workspaces: mapEntries(workspaceService, "workspaces"),
      workspacesBySlug: mapEntries(workspaceService, "workspacesBySlug"),
      members: mapEntries(workspaceService, "members"),
      folders: mapEntries(workspaceService, "folders"),
      foldersByShortId: mapEntries(workspaceService, "foldersByShortId"),
    },
    permissionService: {
      grants: mapEntries(permissionService, "grants"),
    },
    authService: {
      magicLinks: mapEntries(authService, "magicLinks"),
      sessions: mapEntries(authService, "sessions"),
    },
    commentService: {
      threads: mapEntries(commentService, "threads"),
      anchors: mapEntries(commentService, "anchors"),
      replies: mapEntries(commentService, "replies"),
    },
    publicationService: {
      publications: mapEntries(publicationService, "publications"),
    },
    searchService: {
      documents: mapEntries(searchService, "documents"),
    },
    attachmentService: {
      attachments: mapEntries(attachmentService, "attachments"),
    },
    favoriteService: {
      favorites: mapEntries(favoriteService, "favorites"),
    },
    auditService: {
      logs: arrayValue(auditService, "logs"),
    },
    reviewEventService: {
      events: arrayValue(reviewEventService, "events"),
    },
    templateService: {
      templates: mapEntries(templateService, "templates"),
      slugIndex: mapEntries(templateService, "slugIndex"),
      versions: mapEntries(templateService, "versions"),
    },
  };
}

function restoreRuntimeSnapshot(snapshot: RuntimeSnapshot) {
  if (snapshot.version !== 1) return;
  (setupService as unknown as { state: SetupState }).state =
    snapshot.setupState;
  restoreMap(
    pageService,
    "pages",
    snapshot.pageService.pages as [string, unknown][],
  );
  restoreMap(
    pageService,
    "pagesByShortId",
    snapshot.pageService.pagesByShortId as [string, unknown][],
  );
  restoreMap(
    pageService,
    "versions",
    snapshot.pageService.versions as [string, unknown][],
  );
  restoreMap(
    workspaceService,
    "users",
    snapshot.workspaceService.users as [string, unknown][],
  );
  restoreMap(
    workspaceService,
    "usersByEmail",
    snapshot.workspaceService.usersByEmail as [string, unknown][],
  );
  restoreMap(
    workspaceService,
    "workspaces",
    snapshot.workspaceService.workspaces as [string, unknown][],
  );
  restoreMap(
    workspaceService,
    "workspacesBySlug",
    snapshot.workspaceService.workspacesBySlug as [string, unknown][],
  );
  restoreMap(
    workspaceService,
    "members",
    snapshot.workspaceService.members as [string, unknown][],
  );
  restoreMap(
    workspaceService,
    "folders",
    snapshot.workspaceService.folders as [string, unknown][],
  );
  restoreMap(
    workspaceService,
    "foldersByShortId",
    snapshot.workspaceService.foldersByShortId as [string, unknown][],
  );
  restoreMap(
    permissionService,
    "grants",
    snapshot.permissionService.grants as [string, unknown][],
  );
  restoreMap(
    authService,
    "magicLinks",
    snapshot.authService.magicLinks as [string, unknown][],
  );
  restoreMap(
    authService,
    "sessions",
    snapshot.authService.sessions as [string, unknown][],
  );
  restoreMap(
    commentService,
    "threads",
    snapshot.commentService.threads as [string, unknown][],
  );
  restoreMap(
    commentService,
    "anchors",
    (snapshot.commentService.anchors as [string, CommentAnchorRecord][]).map(
      ([threadId, anchor]) => [threadId, normalizeCommentAnchorRecord(anchor)],
    ),
  );
  restoreMap(
    commentService,
    "replies",
    snapshot.commentService.replies as [string, unknown][],
  );
  restoreMap(
    publicationService,
    "publications",
    snapshot.publicationService.publications as [string, unknown][],
  );
  restoreMap(
    searchService,
    "documents",
    snapshot.searchService.documents as [string, unknown][],
  );
  restoreMap(
    attachmentService,
    "attachments",
    snapshot.attachmentService.attachments as [string, unknown][],
  );
  if (snapshot.favoriteService) {
    restoreMap(
      favoriteService,
      "favorites",
      snapshot.favoriteService.favorites as [string, unknown][],
    );
  }
  restoreArray(auditService, "logs", snapshot.auditService.logs as unknown[]);
  restoreArray(
    reviewEventService,
    "events",
    snapshot.reviewEventService.events as unknown[],
  );
  if (snapshot.templateService) {
    restoreMap(
      templateService,
      "templates",
      snapshot.templateService.templates as [string, unknown][],
    );
    restoreMap(
      templateService,
      "slugIndex",
      snapshot.templateService.slugIndex as [string, unknown][],
    );
    restoreMap(
      templateService,
      "versions",
      snapshot.templateService.versions as [string, unknown][],
    );
  }
}

async function nodeStateFilePath() {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const dir = process.env.VPG_STATE_DIR ?? ".vegastack-pages/state";
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "runtime-state.json");
}

async function nodeSqliteFilePath() {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const explicit = process.env.VPG_SQLITE_PATH;
  if (explicit) {
    await fs.mkdir(path.dirname(explicit), { recursive: true });
    return explicit;
  }
  const dir = process.env.VPG_STATE_DIR ?? ".vegastack-pages/state";
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "vegastack-pages.sqlite");
}

async function findNodeMigrationsDir() {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const candidates = [
    process.env.VPG_DB_MIGRATIONS_DIR,
    path.resolve(process.cwd(), "packages/db/migrations"),
    path.resolve(process.cwd(), "../../packages/db/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) return candidate;
  }
  return null;
}

async function createNodeSqliteD1(): Promise<D1Database | null> {
  if (!isNodeRuntime()) return null;
  try {
    const sqliteSpecifier = "node:sqlite";
    const { DatabaseSync } = await import(/* @vite-ignore */ sqliteSpecifier);
    const database = new DatabaseSync(await nodeSqliteFilePath());
    const d1 = new NodeSqliteD1Database(database);
    await runNodeSqliteMigrations(d1);
    return d1;
  } catch (error) {
    console.warn(
      "Falling back to JSON runtime state because node:sqlite could not be initialized.",
      error,
    );
    return null;
  }
}

async function runNodeSqliteMigrations(database: D1Database) {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const migrationsDir = await findNodeMigrationsDir();
  if (!migrationsDir) {
    throw new Error(
      "Could not find database migrations. Set VPG_DB_MIGRATIONS_DIR for Node/Docker deployments.",
    );
  }
  await database.exec?.("PRAGMA foreign_keys = ON");
  await database.exec?.(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
  );
  const appliedRows = await database
    .prepare("SELECT filename FROM schema_migrations")
    .all<{ filename: string }>();
  const applied = new Set(
    (Array.isArray(appliedRows)
      ? appliedRows
      : (appliedRows.results ?? [])
    ).map((row) => row.filename),
  );
  const files = ((await fs.readdir(migrationsDir)) as string[])
    .filter((file: string) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await database.exec?.("BEGIN");
    try {
      await database.exec?.(sql);
      await database
        .prepare(
          "INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)",
        )
        .bind(file, new Date().toISOString())
        .run();
      await database.exec?.("COMMIT");
    } catch (error) {
      await database.exec?.("ROLLBACK");
      throw error;
    }
  }
}

async function hydrateNodeState() {
  if (!isNodeRuntime()) return;
  const fsSpecifier = "node:fs/promises";
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const stateFile = await nodeStateFilePath();
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    restoreRuntimeSnapshot(JSON.parse(raw) as RuntimeSnapshot);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

async function persistNodeState() {
  if (!isNodeRuntime()) return;
  const fsSpecifier = "node:fs/promises";
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const stateFile = await nodeStateFilePath();
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(
    tmpFile,
    JSON.stringify(createRuntimeSnapshot(), null, 2),
    "utf8",
  );
  await fs.rename(tmpFile, stateFile);
}

async function hydrateRuntimeState() {
  const bindings = await getRuntimeBindings();
  assertRuntimeStorageBindings({ bindings });
  await objectStore.configure(bindings?.CONTENT);
  if (!bindings?.DB) {
    runtimeD1 = await createNodeSqliteD1();
    if (runtimeD1) {
      await ensureRuntimeSchema();
      await ensureSearchSchema();
      runtimeHydratedFromNormalizedTables =
        await hydrateNormalizedRuntimeState();
      return;
    }
    await hydrateNodeState();
    return;
  }
  runtimeD1 = bindings.DB;
  await ensureRuntimeSchema();
  await ensureSearchSchema();
  runtimeHydratedFromNormalizedTables = await hydrateNormalizedRuntimeState();
  if (runtimeHydratedFromNormalizedTables) return;

  const row = await runtimeD1
    .prepare("SELECT json FROM runtime_state WHERE key = ?")
    .bind("default")
    .first<{
      json: string;
    }>();
  if (row?.json) {
    restoreRuntimeSnapshot(JSON.parse(row.json) as RuntimeSnapshot);
    await persistNormalizedRuntimeState();
    await d1Run("DELETE FROM runtime_state WHERE key = ?", "default");
  }
}

async function ensureRuntimeSchema() {
  if (!runtimeD1) return;
  await d1Run("PRAGMA foreign_keys = ON");
  await d1Run(
    "CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS review_events (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, page_id TEXT, type TEXT NOT NULL, actor_user_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS review_events_workspace_idx ON review_events(workspace_id)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS review_events_page_idx ON review_events(page_id)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS setup_state (key TEXT PRIMARY KEY NOT NULL, setup_complete INTEGER NOT NULL DEFAULT 0, first_admin_user_id TEXT, first_workspace_id TEXT, updated_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY NOT NULL, count INTEGER NOT NULL, reset_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits(reset_at)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS runtime_locks (key TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS github_sync_connections (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, installation_id INTEGER NOT NULL, repo_owner TEXT, repo_name TEXT, repo_id INTEGER, branch TEXT, root_path TEXT NOT NULL DEFAULT 'docs', include_assets INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('pending', 'success', 'failed', 'idle')), last_synced_at TEXT, last_commit_sha TEXT, last_error TEXT, created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE UNIQUE INDEX IF NOT EXISTS github_sync_connections_workspace_unique ON github_sync_connections(workspace_id)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS github_sync_connections_installation_idx ON github_sync_connections(installation_id)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS github_sync_runs (id TEXT PRIMARY KEY NOT NULL, connection_id TEXT NOT NULL REFERENCES github_sync_connections(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')), started_at TEXT NOT NULL, finished_at TEXT, base_commit_sha TEXT, head_commit_sha TEXT, pages_written INTEGER NOT NULL DEFAULT 0, templates_written INTEGER NOT NULL DEFAULT 0, assets_written INTEGER NOT NULL DEFAULT 0, files_deleted INTEGER NOT NULL DEFAULT 0, error_json TEXT)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS github_sync_runs_connection_idx ON github_sync_runs(connection_id, started_at)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS github_sync_runs_workspace_idx ON github_sync_runs(workspace_id)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS workspace_templates (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'general', source_type TEXT NOT NULL DEFAULT 'markdown', object_key_current TEXT NOT NULL, content_hash TEXT NOT NULL, version_id TEXT NOT NULL, properties_json TEXT NOT NULL DEFAULT '[]', is_builtin INTEGER NOT NULL DEFAULT 0, created_by TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE UNIQUE INDEX IF NOT EXISTS workspace_templates_slug_unique ON workspace_templates(workspace_id, slug)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS workspace_templates_workspace_idx ON workspace_templates(workspace_id)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS workspace_template_versions (id TEXT PRIMARY KEY NOT NULL, template_id TEXT NOT NULL, workspace_id TEXT NOT NULL, object_key TEXT NOT NULL, source_hash TEXT NOT NULL, source_type TEXT NOT NULL, properties_json TEXT NOT NULL DEFAULT '[]', label TEXT, created_by TEXT, created_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS workspace_template_versions_template_idx ON workspace_template_versions(template_id)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS page_favorites (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (user_id, page_id))",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS page_favorites_user_workspace_idx ON page_favorites(user_id, workspace_id, created_at)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS page_favorites_page_idx ON page_favorites(page_id)",
  );
  const pageColumns = await d1All<{ name: string }>("PRAGMA table_info(pages)");
  if (
    pageColumns.length > 0 &&
    !pageColumns.some((column) => column.name === "version_id")
  ) {
    await d1Run("ALTER TABLE pages ADD COLUMN version_id TEXT");
  }
  const folderColumns = await d1All<{ name: string }>(
    "PRAGMA table_info(folders)",
  );
  if (
    folderColumns.length > 0 &&
    !folderColumns.some((column) => column.name === "slug_id")
  ) {
    await d1Run("ALTER TABLE folders ADD COLUMN slug_id TEXT");
    await d1Run(
      "UPDATE folders SET slug_id = slug || '-' || substr(replace(id, 'fld_', ''), 1, 12) WHERE slug_id IS NULL OR slug_id = ''",
    );
    await d1Run(
      "CREATE UNIQUE INDEX IF NOT EXISTS folders_slug_id_unique ON folders(slug_id)",
    );
  }
  await d1Run(
    "CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'folder')), resource_id TEXT NOT NULL, permission TEXT NOT NULL CHECK (permission IN ('view', 'comment', 'edit')), expires_at TEXT, password_hash TEXT, indexing_enabled INTEGER NOT NULL DEFAULT 0, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  await d1Run(
    "CREATE UNIQUE INDEX IF NOT EXISTS publications_resource_unique ON publications(workspace_id, resource_type, resource_id)",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS publications_workspace_idx ON publications(workspace_id)",
  );
  const threadColumns = await d1All<{ name: string }>(
    "PRAGMA table_info(comment_threads)",
  );
  if (
    threadColumns.length > 0 &&
    !threadColumns.some((column) => column.name === "publication_id")
  ) {
    await d1Run("ALTER TABLE comment_threads ADD COLUMN publication_id TEXT");
  }
  if (
    threadColumns.length > 0 &&
    !threadColumns.some((column) => column.name === "guest_session_id")
  ) {
    await d1Run("ALTER TABLE comment_threads ADD COLUMN guest_session_id TEXT");
  }
  const replyColumns = await d1All<{ name: string }>(
    "PRAGMA table_info(comment_replies)",
  );
  if (
    replyColumns.length > 0 &&
    !replyColumns.some((column) => column.name === "publication_id")
  ) {
    await d1Run("ALTER TABLE comment_replies ADD COLUMN publication_id TEXT");
  }
  if (
    replyColumns.length > 0 &&
    !replyColumns.some((column) => column.name === "guest_session_id")
  ) {
    await d1Run("ALTER TABLE comment_replies ADD COLUMN guest_session_id TEXT");
  }
  const anchorColumns = await d1All<{ name: string }>(
    "PRAGMA table_info(comment_anchors)",
  );
  if (
    anchorColumns.length > 0 &&
    !anchorColumns.some((column) => column.name === "anchor_kind")
  ) {
    await d1Run(
      "ALTER TABLE comment_anchors ADD COLUMN anchor_kind TEXT NOT NULL DEFAULT 'text'",
    );
  }
  if (
    anchorColumns.length > 0 &&
    !anchorColumns.some((column) => column.name === "surface")
  ) {
    await d1Run(
      "ALTER TABLE comment_anchors ADD COLUMN surface TEXT NOT NULL DEFAULT 'prose'",
    );
  }
  if (
    anchorColumns.length > 0 &&
    !anchorColumns.some((column) => column.name === "selector_json")
  ) {
    await d1Run("ALTER TABLE comment_anchors ADD COLUMN selector_json TEXT");
  }
  if (
    anchorColumns.length > 0 &&
    !anchorColumns.some((column) => column.name === "confidence")
  ) {
    await d1Run(
      "ALTER TABLE comment_anchors ADD COLUMN confidence TEXT NOT NULL DEFAULT 'active'",
    );
  }
  if (anchorColumns.length > 0) {
    await d1Run(
      "UPDATE comment_anchors SET anchor_kind = 'point', selected_text = CASE WHEN selected_text = '' OR selected_text = 'Selected area' THEN 'Pinned comment' ELSE selected_text END WHERE anchor_kind = 'rect'",
    );
  }
  const workspaceColumns = await d1All<{ name: string }>(
    "PRAGMA table_info(workspaces)",
  );
  if (
    workspaceColumns.length > 0 &&
    !workspaceColumns.some((column) => column.name === "version_retention_days")
  ) {
    await d1Run(
      "ALTER TABLE workspaces ADD COLUMN version_retention_days INTEGER",
    );
  }
}

async function ensureSearchSchema() {
  if (!runtimeD1) return;
  const searchColumns = await d1All<{ name: string }>(
    "PRAGMA table_info(search_documents)",
  );
  if (
    searchColumns.length > 0 &&
    !searchColumns.some((column) => column.name === "resource_type")
  ) {
    await d1Run("DROP TABLE IF EXISTS search_documents_fts");
    await d1Run("DROP TABLE IF EXISTS search_documents");
  }
  await d1Run(
    "CREATE TABLE IF NOT EXISTS search_documents (resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'folder', 'comment_thread')), resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, page_id TEXT, folder_id TEXT, title TEXT NOT NULL, path TEXT NOT NULL, headings_text TEXT NOT NULL DEFAULT '', frontmatter_text TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', comment_text TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (resource_type, resource_id))",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS search_documents_workspace_idx ON search_documents(workspace_id, resource_type, updated_at)",
  );
  await d1Run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(resource_type UNINDEXED, resource_id UNINDEXED, workspace_id UNINDEXED, page_id UNINDEXED, folder_id UNINDEXED, title, path, headings_text, frontmatter_text, body_text, comment_text, tags)",
  );
  await d1Run(
    "CREATE TABLE IF NOT EXISTS search_recent_resources (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'folder', 'comment_thread')), resource_id TEXT NOT NULL, last_opened_at TEXT NOT NULL, open_count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, resource_type, resource_id))",
  );
  await d1Run(
    "CREATE INDEX IF NOT EXISTS search_recent_resources_user_workspace_idx ON search_recent_resources(user_id, workspace_id, last_opened_at)",
  );
}

async function hydrateNormalizedRuntimeState(
  options: { rebuildFts?: boolean } = {},
): Promise<boolean> {
  if (!runtimeD1) return false;

  const users = await d1All<UserRecord>(
    "SELECT id, email, display_name as displayName, role, created_at as createdAt, updated_at as updatedAt FROM users ORDER BY created_at",
  );
  const workspaces = await d1All<WorkspaceRecord>(
    "SELECT id, name, slug, version_retention_days as versionRetentionDays, created_at as createdAt, updated_at as updatedAt FROM workspaces ORDER BY created_at",
  );
  const folders = await d1All<FolderRecord>(
    "SELECT id, workspace_id as workspaceId, parent_folder_id as parentFolderId, name, slug, slug_id as slugId, path, position, created_at as createdAt, updated_at as updatedAt FROM folders ORDER BY path, position",
  );
  const folderPathById = new Map(
    folders.map((folder) => [folder.id, folder.path]),
  );
  const members = await d1All<WorkspaceMemberRecord>(
    "SELECT id, workspace_id as workspaceId, user_id as userId, role, created_at as createdAt, updated_at as updatedAt FROM workspace_members ORDER BY created_at",
  );
  const pages = (
    await d1All<PageRecord & { folderId: string | null }>(
      "SELECT id, workspace_id as workspaceId, folder_id as folderId, title, slug, slug_id as slugId, source_type as sourceType, object_key_current as objectKeyCurrent, content_hash as contentHash, COALESCE(version_id, render_cache_key) as versionId, created_at as createdAt, updated_at as updatedAt FROM pages WHERE deleted_at IS NULL ORDER BY created_at",
    )
  ).map((page) => ({
    id: page.id,
    workspaceId: page.workspaceId,
    folderPath: page.folderId ? (folderPathById.get(page.folderId) ?? "") : "",
    title: page.title,
    slug: page.slug,
    slugId: page.slugId,
    sourceType: page.sourceType,
    objectKeyCurrent: page.objectKeyCurrent,
    contentHash: page.contentHash,
    versionId: page.versionId,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  }));
  const versions = await d1All<PageVersionRecord>(
    "SELECT id, page_id as pageId, workspace_id as workspaceId, object_key as objectKey, source_hash as sourceHash, source_type as sourceType, label, created_reason as createdReason, created_at as createdAt FROM page_versions ORDER BY created_at",
  );
  const permissions = await d1All<PermissionRecord>(
    "SELECT id, workspace_id as workspaceId, subject_type as subjectType, subject_id as subjectId, scope, target_id as targetId, level, created_at as createdAt, updated_at as updatedAt FROM permissions ORDER BY created_at",
  );
  const magicLinks = await d1All<MagicLinkRecord>(
    "SELECT id, email, token_hash as tokenHash, redirect_to as redirectTo, expires_at as expiresAt, consumed_at as consumedAt, created_at as createdAt FROM magic_links ORDER BY created_at",
  );
  const sessions = await d1All<SessionRecord>(
    "SELECT id, user_id as userId, expires_at as expiresAt, created_at as createdAt FROM auth_sessions ORDER BY created_at",
  );
  const threads = await d1All<CommentThreadRecord>(
    "SELECT id, page_id as pageId, workspace_id as workspaceId, status, selected_text as selectedText, guest_name as guestName, guest_session_id as guestSessionId, publication_id as publicationId, resolved_at as resolvedAt, created_at as createdAt, updated_at as updatedAt FROM comment_threads ORDER BY created_at",
  );
  const anchors = (
    await d1All<CommentAnchorRecord & { selectorJson: unknown }>(
      "SELECT thread_id as threadId, source_start as sourceStart, source_end as sourceEnd, rendered_dom_path as renderedDomPath, selected_text as selectedText, prefix_text as prefixText, suffix_text as suffixText, content_hash_at_creation as contentHash, reanchor_status as reanchorStatus, COALESCE(anchor_kind, 'text') as kind, COALESCE(surface, 'prose') as surface, selector_json as selectorJson, COALESCE(confidence, reanchor_status, 'active') as confidence FROM comment_anchors",
    )
  ).map((anchor) =>
    normalizeCommentAnchorRecord({
      ...anchor,
      selector: anchor.selectorJson
        ? (jsonFromDb(anchor.selectorJson) as CommentAnchorRecord["selector"])
        : null,
    }),
  );
  const replies = await d1All<CommentReplyRecord>(
    "SELECT id, thread_id as threadId, body, author_type as authorType, author_user_id as authorUserId, guest_name as guestName, guest_session_id as guestSessionId, publication_id as publicationId, agent_name as agentName, agent_model as agentModel, agent_session_id as agentSessionId, created_at as createdAt FROM comment_replies ORDER BY created_at",
  );
  const publications = (
    await d1All<PublicationRecord & { indexingEnabled: unknown }>(
      "SELECT id, workspace_id as workspaceId, resource_type as resourceType, resource_id as resourceId, permission, expires_at as expiresAt, password_hash as passwordHash, indexing_enabled as indexingEnabled, revoked_at as revokedAt, created_at as createdAt, updated_at as updatedAt FROM publications ORDER BY created_at",
    )
  ).map((publication) => ({
    ...publication,
    indexingEnabled: boolFromDb(publication.indexingEnabled),
  }));
  const attachments = await d1All<AttachmentRecord>(
    "SELECT id, workspace_id as workspaceId, page_id as pageId, filename, object_key as objectKey, content_type as contentType, byte_size as byteSize, created_at as createdAt FROM attachments ORDER BY created_at",
  );
  const favorites = await d1All<FavoriteRecord>(
    "SELECT user_id as userId, workspace_id as workspaceId, page_id as pageId, created_at as createdAt FROM page_favorites ORDER BY created_at",
  );
  const auditLogs = (
    await d1All<Omit<AuditLogRecord, "metadata"> & { metadataJson: unknown }>(
      "SELECT id, workspace_id as workspaceId, actor_user_id as actorUserId, action, target_type as targetType, target_id as targetId, metadata_json as metadataJson, created_at as createdAt FROM audit_logs ORDER BY created_at",
    )
  ).map((log) => ({ ...log, metadata: jsonFromDb(log.metadataJson) }));
  const reviewEvents = (
    await d1All<Omit<ReviewEventRecord, "payload"> & { payloadJson: unknown }>(
      "SELECT id, workspace_id as workspaceId, page_id as pageId, type, actor_user_id as actorUserId, payload_json as payloadJson, created_at as createdAt FROM review_events ORDER BY created_at",
    )
  ).map((event) => ({
    ...event,
    payload: jsonFromDb(event.payloadJson),
  })) as ReviewEventRecord[];
  const searchDocuments = await d1All<SearchDocument>(
    "SELECT resource_type as type, resource_id as id, workspace_id as workspaceId, page_id as pageId, folder_id as folderId, title, path, headings_text as headingsText, frontmatter_text as frontmatterText, body_text as bodyText, comment_text as commentText, tags, url, updated_at as updatedAt FROM search_documents ORDER BY updated_at",
  );
  const templateRows = await d1All<{
    id: string;
    workspaceId: string;
    slug: string;
    name: string;
    description: string;
    category: string;
    sourceType: "markdown" | "mdx";
    objectKeyCurrent: string;
    contentHash: string;
    versionId: string;
    propertiesJson: unknown;
    isBuiltin: unknown;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }>(
    "SELECT id, workspace_id as workspaceId, slug, name, description, category, source_type as sourceType, object_key_current as objectKeyCurrent, content_hash as contentHash, version_id as versionId, properties_json as propertiesJson, is_builtin as isBuiltin, created_by as createdBy, created_at as createdAt, updated_at as updatedAt FROM workspace_templates WHERE deleted_at IS NULL ORDER BY workspace_id, category, name",
  );
  const templates: TemplateRecord[] = templateRows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    category: row.category ?? "general",
    sourceType: row.sourceType,
    objectKeyCurrent: row.objectKeyCurrent,
    contentHash: row.contentHash,
    versionId: row.versionId,
    properties: parseProperties(row.propertiesJson),
    isBuiltin: boolFromDb(row.isBuiltin),
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  const templateVersionRows = await d1All<{
    id: string;
    templateId: string;
    workspaceId: string;
    objectKey: string;
    sourceHash: string;
    sourceType: "markdown" | "mdx";
    propertiesJson: unknown;
    label: string | null;
    createdBy: string | null;
    createdAt: string;
  }>(
    "SELECT id, template_id as templateId, workspace_id as workspaceId, object_key as objectKey, source_hash as sourceHash, source_type as sourceType, properties_json as propertiesJson, label, created_by as createdBy, created_at as createdAt FROM workspace_template_versions ORDER BY created_at",
  );
  const templateVersions: TemplateVersionRecord[] = templateVersionRows.map(
    (row) => ({
      id: row.id,
      templateId: row.templateId,
      workspaceId: row.workspaceId,
      objectKey: row.objectKey,
      sourceHash: row.sourceHash,
      sourceType: row.sourceType,
      properties: parseProperties(row.propertiesJson),
      label: row.label,
      createdBy: row.createdBy ?? null,
      createdAt: row.createdAt,
    }),
  );
  const setup = await runtimeD1
    .prepare(
      "SELECT setup_complete as setupComplete, first_admin_user_id as firstAdminUserId, first_workspace_id as firstWorkspaceId FROM setup_state WHERE key = ?",
    )
    .bind("default")
    .first<{
      setupComplete: unknown;
      firstAdminUserId: string | null;
      firstWorkspaceId: string | null;
    }>();

  restoreMap(
    workspaceService,
    "users",
    users.map((user) => [user.id, user]),
  );
  restoreMap(
    workspaceService,
    "usersByEmail",
    users.map((user) => [user.email, user.id]),
  );
  restoreMap(
    workspaceService,
    "workspaces",
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  restoreMap(
    workspaceService,
    "workspacesBySlug",
    workspaces.map((workspace) => [workspace.slug, workspace.id]),
  );
  restoreMap(
    workspaceService,
    "members",
    members.map((member) => [member.id, member]),
  );
  restoreMap(
    workspaceService,
    "folders",
    folders.map((folder) => [folder.id, folder]),
  );
  restoreMap(
    workspaceService,
    "foldersByShortId",
    folders.map((folder) => [
      folder.slugId.slice(folder.slugId.lastIndexOf("-") + 1),
      folder.id,
    ]),
  );
  restoreMap(
    pageService,
    "pages",
    pages.map((page) => [page.id, page]),
  );
  restoreMap(
    pageService,
    "pagesByShortId",
    pages.map((page) => [
      page.slugId.slice(page.slugId.lastIndexOf("-") + 1),
      page.id,
    ]),
  );
  restoreMap(pageService, "versions", groupByPageVersion(versions));
  restoreMap(
    permissionService,
    "grants",
    permissions.map((grant) => [grant.id, grant]),
  );
  restoreMap(
    authService,
    "magicLinks",
    magicLinks.map((link) => [link.id, link]),
  );
  restoreMap(
    authService,
    "sessions",
    sessions.map((session) => [session.id, session]),
  );
  restoreMap(
    commentService,
    "threads",
    threads.map((thread) => [thread.id, thread]),
  );
  restoreMap(
    commentService,
    "anchors",
    anchors.map((anchor) => [anchor.threadId, anchor]),
  );
  restoreMap(commentService, "replies", groupByCommentReplies(replies));
  restoreMap(
    publicationService,
    "publications",
    publications.map((link) => [link.id, link]),
  );
  restoreMap(
    attachmentService,
    "attachments",
    attachments.map((attachment) => [attachment.id, attachment]),
  );
  restoreMap(
    favoriteService,
    "favorites",
    favorites.map((favorite) => [
      `${favorite.userId}::${favorite.pageId}`,
      favorite,
    ]),
  );
  restoreMap(
    searchService,
    "documents",
    searchDocuments.map((document) => [
      searchDocumentStorageKey(document),
      document,
    ]),
  );
  restoreMap(
    templateService,
    "templates",
    templates.map((template) => [template.id, template]),
  );
  restoreMap(
    templateService,
    "slugIndex",
    templates.map((template) => [
      `${template.workspaceId}::${template.slug}`,
      template.id,
    ]),
  );
  restoreMap(
    templateService,
    "versions",
    groupByTemplateVersion(templateVersions),
  );
  restoreArray(auditService, "logs", auditLogs);
  restoreArray(reviewEventService, "events", reviewEvents);
  (setupService as unknown as { state: SetupState }).state = {
    setupComplete: boolFromDb(setup?.setupComplete),
    firstAdminUserId: setup?.firstAdminUserId ?? null,
    firstWorkspaceId: setup?.firstWorkspaceId ?? null,
  };

  if (options.rebuildFts ?? true) {
    if (searchDocuments.length) {
      await rebuildSearchFts(searchDocuments);
    } else {
      await rebuildSearchIndexFromRuntime({ persist: true });
    }
  }
  return (
    users.length +
      workspaces.length +
      pages.length +
      sessions.length +
      magicLinks.length +
      reviewEvents.length >
      0 || Boolean(setup)
  );
}

function groupByPageVersion(
  versions: PageVersionRecord[],
): [string, PageVersionRecord[]][] {
  const grouped = new Map<string, PageVersionRecord[]>();
  for (const version of versions) {
    grouped.set(version.pageId, [
      ...(grouped.get(version.pageId) ?? []),
      version,
    ]);
  }
  return [...grouped.entries()];
}

function groupByCommentReplies(
  replies: CommentReplyRecord[],
): [string, CommentReplyRecord[]][] {
  const grouped = new Map<string, CommentReplyRecord[]>();
  for (const reply of replies) {
    grouped.set(reply.threadId, [
      ...(grouped.get(reply.threadId) ?? []),
      reply,
    ]);
  }
  return [...grouped.entries()];
}

function groupByTemplateVersion(
  versions: TemplateVersionRecord[],
): [string, TemplateVersionRecord[]][] {
  const grouped = new Map<string, TemplateVersionRecord[]>();
  for (const version of versions) {
    grouped.set(version.templateId, [
      ...(grouped.get(version.templateId) ?? []),
      version,
    ]);
  }
  return [...grouped.entries()];
}

function parseProperties(raw: unknown): TemplateProperty[] {
  if (Array.isArray(raw)) return raw as TemplateProperty[];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as TemplateProperty[]) : [];
  } catch {
    return [];
  }
}

function searchDocumentStorageKey(document: SearchDocument) {
  return `${document.type}:${document.id}`;
}

async function rebuildSearchFts(documents: SearchDocument[]) {
  await d1Run("DELETE FROM search_documents_fts");
  for (const document of documents) {
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
  }
}

async function rebuildSearchIndexFromRuntime(
  options: { persist?: boolean } = {},
): Promise<SearchDocument[]> {
  const documents: SearchDocument[] = [];
  const folders = serviceMapValues<FolderRecord>(workspaceService, "folders");
  const pages = serviceMapValues<PageRecord>(pageService, "pages");
  const threads = serviceMapValues<CommentThreadRecord>(
    commentService,
    "threads",
  );

  for (const folder of folders) {
    documents.push(folderSearchDocument(folder));
  }
  for (const page of pages) {
    const indexed = await pageSearchDocument(page.id);
    if (indexed) documents.push(indexed);
  }
  for (const thread of threads) {
    const indexed = commentThreadSearchDocument(thread.id);
    if (indexed) documents.push(indexed);
  }

  restoreMap(
    searchService,
    "documents",
    documents.map((document) => [searchDocumentStorageKey(document), document]),
  );
  if (options.persist ?? true) {
    await d1Run("DELETE FROM search_documents_fts");
    await d1Run("DELETE FROM search_documents");
    for (const document of documents) {
      await indexSearchDocument(document);
    }
  }
  return documents;
}

export async function ensureRuntimeReady() {
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = hydrateRuntimeState().catch((error) => {
      runtimeReadyPromise = null;
      throw error;
    });
  }
  await runtimeReadyPromise;
}

export async function refreshRuntimeState() {
  await ensureRuntimeReady();
  if (!runtimeD1) return;
  runtimeHydratedFromNormalizedTables = await hydrateNormalizedRuntimeState({
    rebuildFts: false,
  });
}

export async function acquireRuntimeMutationLock(
  input: { timeoutMs?: number; ttlMs?: number } = {},
) {
  await ensureRuntimeReady();
  if (!runtimeD1) {
    return { release: async () => undefined };
  }

  const owner = crypto.randomUUID();
  const ttlMs = input.ttlMs ?? 30_000;
  const timeoutAt = Date.now() + (input.timeoutMs ?? ttlMs + 5_000);

  while (Date.now() < timeoutAt) {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await runtimeD1
      .prepare("DELETE FROM runtime_locks WHERE key = ? AND expires_at <= ?")
      .bind("mutation", nowIso)
      .run();
    await runtimeD1
      .prepare(
        "INSERT OR IGNORE INTO runtime_locks (key, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind("mutation", owner, expiresAt, nowIso)
      .run();
    const row = await runtimeD1
      .prepare("SELECT owner FROM runtime_locks WHERE key = ?")
      .bind("mutation")
      .first<{ owner: string }>();
    if (row?.owner === owner) {
      return {
        release: async () => {
          await runtimeD1
            ?.prepare("DELETE FROM runtime_locks WHERE key = ? AND owner = ?")
            .bind("mutation", owner)
            .run();
        },
      };
    }
    await sleep(75);
  }

  throw new AppError(
    "LOCK_TIMEOUT",
    "Another write is still in progress. Try again.",
    503,
  );
}

export async function persistRuntimeState() {
  await ensureRuntimeReady();
  if (!runtimeD1) {
    await persistNodeState();
    return;
  }
  await persistNormalizedRuntimeState();
}

export async function checkRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
}) {
  await ensureRuntimeReady();
  if (!runtimeD1) {
    return rateLimiter.check(input);
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

export async function pruneExpiredVersions() {
  await ensureRuntimeReady();
  const retentionDays = Number(process.env.VPG_VERSION_RETENTION_DAYS ?? "30");
  const versionEntries = mapEntries<PageVersionRecord[]>(
    pageService,
    "versions",
  );
  const pageEntries = new Map(mapEntries<PageRecord>(pageService, "pages"));
  const workspaceEntries = new Map(
    mapEntries<WorkspaceRecord>(workspaceService, "workspaces"),
  );
  const nextVersionEntries: [string, PageVersionRecord[]][] = [];
  let changed = false;

  for (const [pageId, versions] of versionEntries) {
    const page = pageEntries.get(pageId);
    const workspaceRetentionDays = page
      ? workspaceEntries.get(page.workspaceId)?.versionRetentionDays
      : null;
    const effectiveRetentionDays = workspaceRetentionDays ?? retentionDays;
    if (
      !Number.isFinite(effectiveRetentionDays) ||
      effectiveRetentionDays <= 0
    ) {
      nextVersionEntries.push([pageId, versions]);
      continue;
    }
    const cutoff = Date.now() - effectiveRetentionDays * 24 * 60 * 60_000;
    const newest = versions.at(-1);
    const retained: PageVersionRecord[] = [];
    const pruned: PageVersionRecord[] = [];
    for (const version of versions) {
      const keep =
        version.id === page?.versionId ||
        version.id === newest?.id ||
        Date.parse(version.createdAt) >= cutoff;
      if (keep) {
        retained.push(version);
      } else {
        pruned.push(version);
      }
    }
    nextVersionEntries.push([pageId, retained]);
    if (pruned.length === 0) continue;
    changed = true;
    for (const version of pruned) {
      await objectStore.delete(version.objectKey);
    }
  }

  if (changed) {
    restoreMap(pageService, "versions", nextVersionEntries);
    await persistNormalizedRuntimeState();
  }
}

export async function createMcpSession(input: {
  workspaceId: string;
  userId: string;
  clientName?: string;
  protocolVersion?: string | null;
  ttlDays?: number;
}): Promise<{ session: McpSessionRecord; rawToken: string }> {
  await ensureRuntimeReady();
  const now = new Date().toISOString();
  const rawToken = randomBearerToken();
  const session: McpSessionRecord = {
    id: await mcpSessionIdForBearer(rawToken),
    workspaceId: input.workspaceId,
    userId: input.userId,
    clientName: input.clientName?.trim() || "MCP client",
    protocolVersion: input.protocolVersion ?? null,
    expiresAt: new Date(
      Date.now() + (input.ttlDays ?? 30) * 24 * 60 * 60_000,
    ).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  fallbackMcpSessions.set(session.id, session);
  if (runtimeD1) {
    await d1Run(
      "INSERT INTO agent_sessions (id, workspace_id, user_id, client_name, client_version, model, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      session.workspaceId,
      session.userId,
      session.clientName,
      null,
      null,
      now,
      now,
      now,
    );
    await d1Run(
      "INSERT INTO mcp_sessions (id, workspace_id, user_id, agent_session_id, protocol_version, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      session.workspaceId,
      session.userId,
      session.id,
      session.protocolVersion,
      session.expiresAt,
      session.createdAt,
      session.updatedAt,
    );
  }
  return { session, rawToken };
}

export async function listMcpSessions(input: {
  workspaceId: string;
  userId?: string;
}): Promise<McpSessionRecord[]> {
  await ensureRuntimeReady();
  const now = new Date().toISOString();
  if (runtimeD1) {
    const rows = await d1All<McpSessionRecord>(
      "SELECT m.id, m.workspace_id as workspaceId, m.user_id as userId, COALESCE(a.client_name, 'MCP client') as clientName, m.protocol_version as protocolVersion, m.expires_at as expiresAt, m.created_at as createdAt, m.updated_at as updatedAt FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id WHERE m.workspace_id = ? AND m.expires_at > ? ORDER BY m.created_at DESC",
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
  if (runtimeD1) {
    const row = await runtimeD1
      .prepare(
        "SELECT m.id, m.workspace_id as workspaceId, m.user_id as userId, COALESCE(a.client_name, 'MCP client') as clientName, m.protocol_version as protocolVersion, m.expires_at as expiresAt, m.created_at as createdAt, m.updated_at as updatedAt FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id WHERE m.id = ?",
      )
      .bind(hashedSessionId)
      .first<McpSessionRecord>();
    if (row && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now()))
      return row;
    const legacyRow = await runtimeD1
      .prepare(
        "SELECT m.id, m.workspace_id as workspaceId, m.user_id as userId, COALESCE(a.client_name, 'MCP client') as clientName, m.protocol_version as protocolVersion, m.expires_at as expiresAt, m.created_at as createdAt, m.updated_at as updatedAt FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id WHERE m.id = ?",
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
    await d1Run(
      "DELETE FROM mcp_sessions WHERE id = ? AND workspace_id = ?",
      sessionId,
      input.workspaceId,
    );
    await d1Run("DELETE FROM agent_sessions WHERE id = ?", sessionId);
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
    if ((await legacyMcpSessionListId(session.id)) === input.sessionId) {
      return session.id;
    }
  }
  return input.sessionId;
}

async function persistNormalizedRuntimeState() {
  if (!runtimeD1) return;
  await d1Batch(() => persistNormalizedRuntimeStateBatch());
}

async function persistNormalizedRuntimeStateBatch() {
  if (!runtimeD1) return;
  const now = new Date().toISOString();

  const users = serviceMapValues<UserRecord>(workspaceService, "users");
  const workspaces = serviceMapValues<WorkspaceRecord>(
    workspaceService,
    "workspaces",
  );
  const members = serviceMapValues<WorkspaceMemberRecord>(
    workspaceService,
    "members",
  );
  const folders = serviceMapValues<FolderRecord>(workspaceService, "folders");
  const pages = serviceMapValues<PageRecord>(pageService, "pages");
  const versions = serviceMapValues<PageVersionRecord[]>(
    pageService,
    "versions",
  ).flat();
  const grants = serviceMapValues<PermissionRecord>(
    permissionService,
    "grants",
  );
  const magicLinks = serviceMapValues<MagicLinkRecord>(
    authService,
    "magicLinks",
  );
  const sessions = serviceMapValues<SessionRecord>(authService, "sessions");
  const threads = serviceMapValues<CommentThreadRecord>(
    commentService,
    "threads",
  );
  const anchors = serviceMapValues<CommentAnchorRecord>(
    commentService,
    "anchors",
  );
  const replies = serviceMapValues<CommentReplyRecord[]>(
    commentService,
    "replies",
  ).flat();
  const publications = serviceMapValues<PublicationRecord>(
    publicationService,
    "publications",
  );
  const attachments = serviceMapValues<AttachmentRecord>(
    attachmentService,
    "attachments",
  );
  const favorites = serviceMapValues<FavoriteRecord>(
    favoriteService,
    "favorites",
  );
  const searchDocuments = serviceMapValues<SearchDocument>(
    searchService,
    "documents",
  );
  const auditLogs = serviceArrayValues<AuditLogRecord>(auditService, "logs");
  const reviewEvents = serviceArrayValues<ReviewEventRecord>(
    reviewEventService,
    "events",
  );
  const templates = serviceMapValues<TemplateRecord>(
    templateService,
    "templates",
  );
  const templateVersions = serviceMapValues<TemplateVersionRecord[]>(
    templateService,
    "versions",
  ).flat();
  const setup = setupService.status();
  const userIds = new Set(users.map((user) => user.id));
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const preservedAuthIdentities = (
    await d1All<AuthIdentityRow>(
      "SELECT id, user_id as userId, provider, provider_subject as providerSubject, email, created_at as createdAt, updated_at as updatedAt FROM auth_identities",
    )
  ).filter((identity) => userIds.has(identity.userId));
  const preservedJobs = (
    await d1All<JobRow>(
      "SELECT id, workspace_id as workspaceId, type, status, payload_json as payloadJson, result_json as resultJson, error_json as errorJson, created_at as createdAt, updated_at as updatedAt FROM jobs",
    )
  ).filter((job) => !job.workspaceId || workspaceIds.has(job.workspaceId));
  const persistedMcpSessions = (
    await d1All<McpSessionRecord>(
      "SELECT m.id, m.workspace_id as workspaceId, m.user_id as userId, COALESCE(a.client_name, 'MCP client') as clientName, m.protocol_version as protocolVersion, m.expires_at as expiresAt, m.created_at as createdAt, m.updated_at as updatedAt FROM mcp_sessions m LEFT JOIN agent_sessions a ON a.id = m.agent_session_id",
    )
  ).filter(
    (session) =>
      Date.parse(session.expiresAt) > Date.now() &&
      users.some((user) => user.id === session.userId) &&
      workspaces.some((workspace) => workspace.id === session.workspaceId),
  );
  const preservedGitHubConnections = (
    await d1All<GitHubSyncConnectionRow>(
      "SELECT id, workspace_id as workspaceId, installation_id as installationId, repo_owner as repoOwner, repo_name as repoName, repo_id as repoId, branch, root_path as rootPath, include_assets as includeAssets, enabled, last_status as lastStatus, last_synced_at as lastSyncedAt, last_commit_sha as lastCommitSha, last_error as lastError, created_by as createdBy, created_at as createdAt, updated_at as updatedAt FROM github_sync_connections",
    )
  ).filter((connection) => workspaceIds.has(connection.workspaceId));
  const preservedGitHubConnectionIds = new Set(
    preservedGitHubConnections.map((connection) => connection.id),
  );
  const preservedGitHubRuns = (
    await d1All<GitHubSyncRunRow>(
      "SELECT id, connection_id as connectionId, workspace_id as workspaceId, status, started_at as startedAt, finished_at as finishedAt, base_commit_sha as baseCommitSha, head_commit_sha as headCommitSha, pages_written as pagesWritten, templates_written as templatesWritten, assets_written as assetsWritten, files_deleted as filesDeleted, error_json as errorJson FROM github_sync_runs",
    )
  ).filter(
    (run) =>
      workspaceIds.has(run.workspaceId) &&
      preservedGitHubConnectionIds.has(run.connectionId),
  );

  await deleteNormalizedRuntimeState();

  for (const user of users) {
    await d1Run(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      user.id,
      user.email,
      user.displayName,
      user.role,
      user.createdAt,
      user.updatedAt,
    );
  }
  for (const identity of preservedAuthIdentities) {
    await d1Run(
      "INSERT INTO auth_identities (id, user_id, provider, provider_subject, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      identity.id,
      identity.userId,
      identity.provider,
      identity.providerSubject,
      identity.email,
      identity.createdAt,
      identity.updatedAt,
    );
  }
  for (const link of magicLinks) {
    await d1Run(
      "INSERT INTO magic_links (id, email, token_hash, redirect_to, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      link.id,
      link.email,
      link.tokenHash,
      link.redirectTo,
      link.expiresAt,
      link.consumedAt,
      link.createdAt,
    );
  }
  for (const session of sessions) {
    await d1Run(
      "INSERT INTO auth_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      session.id,
      session.userId,
      session.expiresAt,
      session.createdAt,
    );
  }
  for (const workspace of workspaces) {
    await d1Run(
      "INSERT INTO workspaces (id, name, slug, version_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      workspace.id,
      workspace.name,
      workspace.slug,
      workspace.versionRetentionDays,
      workspace.createdAt,
      workspace.updatedAt,
    );
  }
  for (const connection of preservedGitHubConnections) {
    await d1Run(
      "INSERT INTO github_sync_connections (id, workspace_id, installation_id, repo_owner, repo_name, repo_id, branch, root_path, include_assets, enabled, last_status, last_synced_at, last_commit_sha, last_error, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      connection.id,
      connection.workspaceId,
      connection.installationId,
      connection.repoOwner,
      connection.repoName,
      connection.repoId,
      connection.branch,
      connection.rootPath,
      connection.includeAssets ? 1 : 0,
      connection.enabled ? 1 : 0,
      connection.lastStatus,
      connection.lastSyncedAt,
      connection.lastCommitSha,
      connection.lastError,
      connection.createdBy && userIds.has(connection.createdBy)
        ? connection.createdBy
        : null,
      connection.createdAt,
      connection.updatedAt,
    );
  }
  for (const run of preservedGitHubRuns) {
    await d1Run(
      "INSERT INTO github_sync_runs (id, connection_id, workspace_id, status, started_at, finished_at, base_commit_sha, head_commit_sha, pages_written, templates_written, assets_written, files_deleted, error_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      run.id,
      run.connectionId,
      run.workspaceId,
      run.status,
      run.startedAt,
      run.finishedAt,
      run.baseCommitSha,
      run.headCommitSha,
      run.pagesWritten,
      run.templatesWritten,
      run.assetsWritten,
      run.filesDeleted,
      run.errorJson,
    );
  }
  for (const job of preservedJobs) {
    await d1Run(
      "INSERT INTO jobs (id, workspace_id, type, status, payload_json, result_json, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      job.id,
      job.workspaceId,
      job.type,
      job.status,
      job.payloadJson,
      job.resultJson,
      job.errorJson,
      job.createdAt,
      job.updatedAt,
    );
  }
  for (const session of persistedMcpSessions) {
    await d1Run(
      "INSERT INTO agent_sessions (id, workspace_id, user_id, client_name, client_version, model, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      session.workspaceId,
      session.userId,
      session.clientName,
      null,
      null,
      session.updatedAt,
      session.createdAt,
      session.updatedAt,
    );
    await d1Run(
      "INSERT INTO mcp_sessions (id, workspace_id, user_id, agent_session_id, protocol_version, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      session.workspaceId,
      session.userId,
      session.id,
      session.protocolVersion,
      session.expiresAt,
      session.createdAt,
      session.updatedAt,
    );
  }
  for (const member of members) {
    await d1Run(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      member.id,
      member.workspaceId,
      member.userId,
      member.role,
      member.createdAt,
      member.updatedAt,
    );
  }
  for (const folder of folders) {
    await d1Run(
      "INSERT INTO folders (id, workspace_id, parent_folder_id, name, slug, slug_id, path, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      folder.id,
      folder.workspaceId,
      folder.parentFolderId,
      folder.name,
      folder.slug,
      folder.slugId,
      folder.path,
      folder.position,
      folder.createdAt,
      folder.updatedAt,
    );
  }
  for (const grant of grants) {
    await d1Run(
      "INSERT INTO permissions (id, workspace_id, subject_type, subject_id, scope, target_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      grant.id,
      grant.workspaceId,
      grant.subjectType,
      grant.subjectId,
      grant.scope,
      grant.targetId,
      grant.level,
      grant.createdAt,
      grant.updatedAt,
    );
  }
  for (const page of pages) {
    await d1Run(
      "INSERT INTO pages (id, workspace_id, folder_id, title, slug, slug_id, source_type, object_key_current, frontmatter_json, content_hash, version_id, render_cache_key, position, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      page.id,
      page.workspaceId,
      folderIdForPath(page.workspaceId, page.folderPath),
      page.title,
      page.slug,
      page.slugId,
      page.sourceType,
      page.objectKeyCurrent,
      "{}",
      page.contentHash,
      page.versionId,
      null,
      1000,
      null,
      page.createdAt,
      page.updatedAt,
    );
  }
  for (const version of versions) {
    await d1Run(
      "INSERT INTO page_versions (id, page_id, workspace_id, object_key, source_hash, source_type, label, created_reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      version.id,
      version.pageId,
      version.workspaceId,
      version.objectKey,
      version.sourceHash,
      version.sourceType,
      version.label,
      version.createdReason,
      null,
      version.createdAt,
    );
  }
  for (const attachment of attachments) {
    await d1Run(
      "INSERT INTO attachments (id, workspace_id, page_id, filename, object_key, content_type, byte_size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      attachment.id,
      attachment.workspaceId,
      attachment.pageId,
      attachment.filename,
      attachment.objectKey,
      attachment.contentType,
      attachment.byteSize,
      null,
      attachment.createdAt,
    );
  }
  for (const favorite of favorites) {
    await d1Run(
      "INSERT INTO page_favorites (user_id, workspace_id, page_id, created_at) VALUES (?, ?, ?, ?)",
      favorite.userId,
      favorite.workspaceId,
      favorite.pageId,
      favorite.createdAt,
    );
  }
  for (const thread of threads) {
    await d1Run(
      "INSERT INTO comment_threads (id, page_id, workspace_id, status, selected_text, guest_name, guest_session_id, publication_id, resolved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      thread.id,
      thread.pageId,
      thread.workspaceId,
      thread.status,
      thread.selectedText,
      thread.guestName,
      thread.guestSessionId ?? null,
      thread.publicationId ?? null,
      thread.resolvedAt,
      thread.createdAt,
      thread.updatedAt,
    );
  }
  for (const anchor of anchors) {
    await d1Run(
      "INSERT INTO comment_anchors (thread_id, source_start, source_end, rendered_dom_path, selected_text, prefix_text, suffix_text, content_hash_at_creation, reanchor_status, anchor_kind, surface, selector_json, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      anchor.threadId,
      anchor.sourceStart,
      anchor.sourceEnd,
      anchor.renderedDomPath ?? null,
      anchor.selectedText,
      anchor.prefixText,
      anchor.suffixText,
      anchor.contentHash,
      anchor.reanchorStatus,
      anchor.kind ?? "text",
      anchor.surface ?? "prose",
      anchor.selector ? jsonToDb(anchor.selector) : null,
      anchor.confidence ?? anchor.reanchorStatus,
    );
  }
  for (const reply of replies) {
    await d1Run(
      "INSERT INTO comment_replies (id, thread_id, body, author_type, author_user_id, guest_name, guest_session_id, publication_id, agent_name, agent_model, agent_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      reply.id,
      reply.threadId,
      reply.body,
      reply.authorType,
      reply.authorUserId,
      reply.guestName,
      reply.guestSessionId ?? null,
      reply.publicationId ?? null,
      reply.agentName,
      reply.agentModel,
      reply.agentSessionId,
      reply.createdAt,
    );
  }
  for (const publication of publications) {
    await d1Run(
      "INSERT INTO publications (id, workspace_id, resource_type, resource_id, permission, expires_at, password_hash, indexing_enabled, revoked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      publication.id,
      publication.workspaceId,
      publication.resourceType,
      publication.resourceId,
      publication.permission,
      publication.expiresAt,
      publication.passwordHash,
      publication.indexingEnabled ? 1 : 0,
      publication.revokedAt,
      publication.createdAt,
      publication.updatedAt,
    );
  }
  for (const document of searchDocuments) {
    await d1Run(
      "INSERT INTO search_documents (resource_type, resource_id, workspace_id, page_id, folder_id, title, path, headings_text, frontmatter_text, body_text, comment_text, tags, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      document.updatedAt ?? now,
    );
  }
  await rebuildSearchFts(searchDocuments);
  for (const log of auditLogs) {
    await d1Run(
      "INSERT INTO audit_logs (id, workspace_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      log.id,
      log.workspaceId,
      log.actorUserId,
      log.action,
      log.targetType,
      log.targetId,
      jsonToDb(log.metadata),
      log.createdAt,
    );
  }
  for (const event of reviewEvents) {
    await d1Run(
      "INSERT INTO review_events (id, workspace_id, page_id, type, actor_user_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      event.id,
      event.workspaceId,
      event.pageId,
      event.type,
      event.actorUserId,
      jsonToDb(event.payload),
      event.createdAt,
    );
  }
  for (const template of templates) {
    await d1Run(
      "INSERT INTO workspace_templates (id, workspace_id, slug, name, description, category, source_type, object_key_current, content_hash, version_id, properties_json, is_builtin, created_by, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      template.id,
      template.workspaceId,
      template.slug,
      template.name,
      template.description,
      template.category,
      template.sourceType,
      template.objectKeyCurrent,
      template.contentHash,
      template.versionId,
      JSON.stringify(template.properties ?? []),
      template.isBuiltin ? 1 : 0,
      template.createdBy,
      null,
      template.createdAt,
      template.updatedAt,
    );
  }
  for (const version of templateVersions) {
    await d1Run(
      "INSERT INTO workspace_template_versions (id, template_id, workspace_id, object_key, source_hash, source_type, properties_json, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      version.id,
      version.templateId,
      version.workspaceId,
      version.objectKey,
      version.sourceHash,
      version.sourceType,
      JSON.stringify(version.properties ?? []),
      version.label,
      version.createdBy,
      version.createdAt,
    );
  }
  await d1Run(
    "INSERT INTO setup_state (key, setup_complete, first_admin_user_id, first_workspace_id, updated_at) VALUES (?, ?, ?, ?, ?)",
    "default",
    setup.setupComplete ? 1 : 0,
    setup.firstAdminUserId,
    setup.firstWorkspaceId,
    now,
  );
}

async function deleteNormalizedRuntimeState() {
  await d1Run("DELETE FROM setup_state");
  await d1Run("DELETE FROM review_events");
  await d1Run("DELETE FROM audit_logs");
  await d1Run("DELETE FROM search_documents_fts");
  await d1Run("DELETE FROM search_documents");
  await d1Run("DELETE FROM publications");
  await d1Run("DELETE FROM comment_replies");
  await d1Run("DELETE FROM comment_anchors");
  await d1Run("DELETE FROM comment_threads");
  await d1Run("DELETE FROM page_favorites");
  await d1Run("DELETE FROM attachments");
  await d1Run("DELETE FROM page_versions");
  await d1Run("DELETE FROM pages");
  await d1Run("DELETE FROM permissions");
  await d1Run("DELETE FROM folders");
  await d1Run("DELETE FROM workspace_members");
  await d1Run("DELETE FROM workspace_template_versions");
  await d1Run("DELETE FROM workspace_templates");
  await d1Run("DELETE FROM mcp_sessions");
  await d1Run("DELETE FROM agent_sessions");
  await d1Run("DELETE FROM github_sync_runs");
  await d1Run("DELETE FROM github_sync_connections");
  await d1Run("DELETE FROM jobs");
  await d1Run("DELETE FROM auth_identities");
  await d1Run("DELETE FROM auth_sessions");
  await d1Run("DELETE FROM magic_links");
  await d1Run("DELETE FROM workspaces");
  await d1Run("DELETE FROM users");
}

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

async function pageSearchDocument(
  pageId: string,
): Promise<SearchDocument | null> {
  const page = await pageService.getPage(pageId);
  if (!page) return null;
  const rendered =
    page.page.sourceType === "html" ? null : await renderMarkdown(page.source);
  const htmlText =
    page.page.sourceType === "html" ? htmlToSearchText(page.source) : null;
  return {
    type: "page",
    id: page.page.id,
    workspaceId: page.page.workspaceId,
    pageId: page.page.id,
    folderId:
      workspaceService
        .listFolders(page.page.workspaceId)
        .find((folder) => folder.path === page.page.folderPath)?.id ?? null,
    title: page.page.title,
    path: page.page.folderPath
      ? `${page.page.folderPath}/${page.page.title}`
      : page.page.title,
    headingsText:
      htmlText?.headings ??
      rendered?.headings.map((heading) => heading.text).join("\n") ??
      "",
    frontmatterText: rendered ? flattenFrontmatter(rendered.frontmatter) : "",
    bodyText: htmlText?.body ?? rendered?.plainText ?? "",
    commentText: "",
    tags: "page document",
    url: `/p/${page.page.slugId}`,
    updatedAt: page.page.updatedAt,
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

function commentThreadSearchDocument(threadId: string): SearchDocument | null {
  const thread = commentService.getThread(threadId);
  if (!thread) return null;
  const page = pageService
    .listPages(thread.thread.workspaceId)
    .find((candidate) => candidate.id === thread.thread.pageId);
  if (!page) return null;
  const commentText = [
    thread.thread.selectedText,
    thread.anchor.prefixText,
    thread.anchor.suffixText,
    ...thread.replies.map((reply) => reply.body),
  ].join("\n");
  return {
    type: "comment_thread",
    id: thread.thread.id,
    workspaceId: thread.thread.workspaceId,
    pageId: page.id,
    folderId:
      workspaceService
        .listFolders(page.workspaceId)
        .find((folder) => folder.path === page.folderPath)?.id ?? null,
    title: `Comment on ${page.title}`,
    path: page.folderPath ? `${page.folderPath}/${page.title}` : page.title,
    bodyText: thread.thread.selectedText,
    commentText,
    tags: `comment thread ${thread.thread.status}`,
    url: `/p/${page.slugId}?thread_id=${encodeURIComponent(thread.thread.id)}`,
    updatedAt: thread.thread.updatedAt,
  };
}

export async function indexFolder(folderId: string) {
  const folder = workspaceService.getFolder(folderId);
  if (!folder) return;
  const document = folderSearchDocument(folder);
  searchService.index(document);
  await indexSearchDocument(document);
}

export async function indexCommentThread(threadId: string) {
  const document = commentThreadSearchDocument(threadId);
  if (!document) return;
  searchService.index(document);
  await indexSearchDocument(document);
}

export async function removeSearchResource(
  type: SearchResourceType,
  id: string,
) {
  searchService.remove(type, id);
  if (!runtimeD1) return;
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
  if (!runtimeD1 || !ftsQuery) {
    return searchService.search(workspaceId, query, {
      limit,
      type,
      favoritePageIds: input.favoritePageIds,
      recentResourceIds: input.recentResourceIds,
    });
  }
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

const seedPages = [
  {
    id: "pg_a8f31c000000000000000000",
    title: "Get Started",
    folderPath: "",
    source: demoPageSource,
  },
  {
    id: "pg_b7e42d000000000000000000",
    title: "Agent Review Workflow",
    folderPath: "guides",
    source: agentReviewWorkflowSource,
  },
  {
    id: "pg_c9d54e000000000000000000",
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
  let created = 0;
  let existing = 0;
  for (const spec of builtinTemplates) {
    if (templateService.getTemplateBySlug(input.workspaceId, spec.slug)) {
      existing += 1;
      continue;
    }
    await templateService.createTemplate({
      workspaceId: input.workspaceId,
      slug: spec.slug,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      source: spec.body,
      sourceType: "markdown",
      properties: spec.properties,
      isBuiltin: true,
      createdBy: input.actorUserId ?? null,
    });
    created += 1;
  }
  return { created, existing };
}

export async function ensureSeedData() {
  await ensureRuntimeReady();
  if (
    process.env.VPG_DEPLOYMENT_MODE === "managed" ||
    process.env.VPG_PUBLIC_SIGNUP === "true"
  ) {
    return;
  }
  if (setupService.status().setupComplete) {
    return;
  }
  const demoSeedEnabled =
    process.env.VPG_DEMO_SEED === "true" ||
    (import.meta.env.DEV && process.env.VPG_DEMO_SEED !== "false");
  if (!demoSeedEnabled) {
    return;
  }
  const admin = workspaceService.createUser({
    id: "usr_demo_admin",
    email: "admin@example.com",
    displayName: "Demo Admin",
    role: "instance_admin",
  });
  const workspace =
    workspaceService.getWorkspace("wks_demo") ??
    workspaceService.createWorkspace({
      id: "wks_demo",
      name: "VegaStack Pages",
      slug: "vegastack-pages",
    });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: admin.id,
    role: "admin",
  });
  if (!workspaceService.getFolder("fld_guides")) {
    workspaceService.createFolder({
      id: "fld_guides",
      workspaceId: workspace.id,
      name: "Guides",
      position: 1,
    });
  }
  if (!workspaceService.getFolder("fld_agents")) {
    workspaceService.createFolder({
      id: "fld_agents",
      workspaceId: workspace.id,
      name: "Agents",
      position: 2,
    });
  }
  for (const folder of workspaceService.listFolders(workspace.id)) {
    await indexFolder(folder.id);
  }

  for (const seedPage of seedPages) {
    const existing = await pageService.getPage(seedPage.id);
    const page =
      existing ??
      (await pageService.createPage({
        id: seedPage.id,
        workspaceId: workspace.id,
        folderPath: seedPage.folderPath,
        title: seedPage.title,
        sourceType: "markdown",
        source: seedPage.source,
      }));
    await indexPage(page.page.id);
  }
  await seedBuiltinTemplates({
    workspaceId: workspace.id,
    actorUserId: admin.id,
  });
  if (
    !auditService
      .list({ workspaceId: workspace.id })
      .some((log) => log.action === "workspace.seeded")
  ) {
    auditService.record({
      workspaceId: workspace.id,
      actorUserId: admin.id,
      action: "workspace.seeded",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { page_ids: seedPages.map((page) => page.id) },
    });
  }
  await persistRuntimeState();
}

export async function seedWorkspace(input: {
  workspaceId: string;
  actorUserId?: string | null;
}): Promise<WorkspaceSeedResult> {
  await ensureRuntimeReady();
  const workspace = workspaceService.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${input.workspaceId}`);
  }

  const existingFolders = workspaceService.listFolders(workspace.id);
  if (!existingFolders.some((folder) => folder.path === "guides")) {
    workspaceService.createFolder({
      workspaceId: workspace.id,
      name: "Guides",
      position: 1,
    });
  }
  if (!existingFolders.some((folder) => folder.path === "agents")) {
    workspaceService.createFolder({
      workspaceId: workspace.id,
      name: "Agents",
      position: 2,
    });
  }

  const existingPages = pageService.listPages(workspace.id);
  const pages =
    existingPages.length > 0
      ? existingPages
      : (
          await Promise.all(
            seedPages.map((seedPage) =>
              pageService.createPage({
                workspaceId: workspace.id,
                folderPath: seedPage.folderPath,
                title: seedPage.title,
                sourceType: "markdown",
                source: seedPage.source,
              }),
            ),
          )
        ).map((created) => created.page);

  await seedBuiltinTemplates({
    workspaceId: workspace.id,
    actorUserId: input.actorUserId ?? null,
  });

  if (
    !auditService
      .list({ workspaceId: workspace.id })
      .some((log) => log.action === "workspace.seeded")
  ) {
    auditService.record({
      workspaceId: workspace.id,
      actorUserId: input.actorUserId ?? null,
      action: "workspace.seeded",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { page_ids: pages.map((page) => page.id) },
    });
  }

  await persistRuntimeState();
  await rebuildSearchIndexFromRuntime({ persist: true });

  return {
    workspace,
    firstPageSlugId: pages[0]?.slugId ?? "get-started-a8f31c000000",
    pageIds: pages.map((page) => page.id),
  };
}

export async function indexPage(pageId: string) {
  const document = await pageSearchDocument(pageId);
  if (!document) return;
  searchService.index(document);
  await indexSearchDocument(document);
}
