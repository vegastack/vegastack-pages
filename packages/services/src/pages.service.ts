// PagesService — direct-D1 reads/writes against the pages +
// page_versions tables, with object-store side effects for the source
// blob.
//
// Plan 011 §5 phase 14 (the hardest). Replaces the in-memory PageRepo
// backed by packages/core/src/page-service.ts with plain async
// functions over ServiceContext. Same external surface — every existing
// call site (apps/web/src/pages/api/**) keeps working.
//
// Why this phase is harder than its siblings:
//   1. Optimistic concurrency. updateSource MUST be safe under racing
//      callers. We do this with a single atomic
//        UPDATE pages SET ... WHERE id = ?1 AND version_id = ?2 RETURNING ...
//      and treat the missing row as VERSION_CONFLICT.
//   2. R2 source handling. Source blobs live in the object store under
//      content-addressed keys (pages/{wsId}/{pageId}/source-{hash}.{ext}).
//      Reads always go through ctx.objectStore.get; writes always put
//      BEFORE the D1 row so a row never points at a missing object.
//   3. Soft delete. deleted_at is the truth — list/get/getBySlugId
//      filter it out.
//   4. has_* flags. We do a cheap regex scan of the source so the
//      sidebar / page renderer can pre-decide what features to load
//      without rendering. Renderer-driven flags are Day 9 work.
//
// Authorization contract: services validate input shape and existence
// only. Routes (apps/web/src/pages/api/**) enforce per-page / per-folder
// permission BEFORE calling these mutations.
//
// Each mutation finishes by computing tree_version via
// ctx.computeTreeVersion(workspaceId) so the envelope reflects the
// post-write nav state.

import {
  AppError,
  makePageSlugId,
  slugifyTitle,
  stripLeadingTitleFromSource,
} from "@vegastack/pages-core";
import { createId, idPrefixes } from "@vegastack/pages-core";
import {
  d1AllRows,
  type D1Database,
  type D1PreparedStatement,
} from "@vegastack/pages-db";
import { renderAtSave } from "@vegastack/pages-renderer";
import type { MutationEnvelope, ServiceContext } from "./context.ts";
import { requireDb, requireObjectStore } from "./context.ts";
import type {
  CreatePageInput,
  MovePageInput,
  PageRecord,
  PageVersionRecord,
  PageWithSource,
  SourceType,
  UpdateSourceInput,
  UpdateSourceResult,
} from "./repo/page.repo.ts";
import { ServiceError } from "./errors.ts";
import { buildEnvelope } from "./envelope.ts";
import { clampLimit, decodeCursor, encodeCursor } from "./cursor.ts";
import type { PaginatedResult } from "./cursor.ts";
import * as publications from "./publications.service.ts";

export type ServiceOutput<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

// db.batch is optional in the minimal D1 type; node-sqlite test adapter
// implements it but a thinner adapter might not. Fall back to sequential
// .run() so we work everywhere.
async function runBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const stmt of statements) await stmt.run();
}

// ---------------------------------------------------------------------------
// Row shapes + helpers
// ---------------------------------------------------------------------------

type PageRow = {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  title: string;
  slug: string;
  slug_id: string;
  source_type: string;
  object_key_current: string;
  content_hash: string;
  version_id: string | null;
  position: number;
  has_code: number;
  has_mermaid: number;
  has_math: number;
  has_wardley: number;
  has_cytoscape: number;
  has_iframe: number;
  rendered_artifact_key: string | null;
  deleted_at: string | null;
  deleted_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

type PageVersionRow = {
  id: string;
  page_id: string;
  workspace_id: string;
  object_key: string;
  source_hash: string;
  source_type: string;
  label: string | null;
  created_reason: string;
  created_by: string | null;
  created_at: string;
};

const PAGE_COLUMNS =
  "id, workspace_id, folder_id, title, slug, slug_id, source_type, " +
  "object_key_current, content_hash, version_id, position, " +
  "has_code, has_mermaid, has_math, has_wardley, has_cytoscape, has_iframe, " +
  "rendered_artifact_key, deleted_at, deleted_by_user_id, created_at, updated_at";

const VERSION_COLUMNS =
  "id, page_id, workspace_id, object_key, source_hash, source_type, " +
  "label, created_reason, created_by, created_at";

function normalizeSourceType(value: string): SourceType {
  return value === "mdx" ? "mdx" : value === "html" ? "html" : "markdown";
}

function extensionFor(sourceType: SourceType): string {
  return sourceType === "mdx" ? "mdx" : sourceType === "html" ? "html" : "md";
}

function contentTypeFor(sourceType: SourceType): string {
  return sourceType === "html"
    ? "text/html; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// Cheap feature scan. Hand-rolled so we don't pay the cost of a real
// markdown AST on every save. The renderer can refine these later; for
// now we just need "is mermaid likely present?" precision.
function scanFlags(
  source: string,
  sourceType: SourceType,
): {
  has_code: number;
  has_mermaid: number;
  has_math: number;
  has_wardley: number;
  has_cytoscape: number;
  has_iframe: number;
} {
  if (sourceType === "html") {
    return {
      has_code: 0,
      has_mermaid: 0,
      has_math: 0,
      has_wardley: 0,
      has_cytoscape: 0,
      has_iframe: 1,
    };
  }
  return {
    has_code: /```/.test(source) ? 1 : 0,
    has_mermaid: /```mermaid\b/.test(source) ? 1 : 0,
    has_math: /\$\$|\\\(|\\\[/.test(source) ? 1 : 0,
    has_wardley: /```wardley\b/.test(source) ? 1 : 0,
    has_cytoscape: /```cytoscape\b/.test(source) ? 1 : 0,
    has_iframe: /<iframe\b/i.test(source) ? 1 : 0,
  };
}

function buildObjectKey(
  workspaceId: string,
  pageId: string,
  hash: string,
  sourceType: SourceType,
): string {
  return `pages/${workspaceId}/${pageId}/source-${hash}.${extensionFor(sourceType)}`;
}

// Resolve a folder_id → folder path. Used so the PageRecord we return
// keeps the existing `folderPath` shape every consumer expects. Returns
// "" for the root (folder_id IS NULL).
async function folderPathForId(
  db: D1Database,
  folderId: string | null,
): Promise<string> {
  if (!folderId) return "";
  const row = await db
    .prepare("SELECT path FROM folders WHERE id = ?1")
    .bind(folderId)
    .first<{ path: string }>();
  // Strip the leading "/" so callers get "docs/guides" not "/docs/guides".
  // That matches what the legacy PageService.movePage / createPage stored.
  return row ? row.path.replace(/^\/+/, "") : "";
}

// Reverse of the above: look up a folder_id by path. The caller passes
// the path WITHOUT a leading slash (matching the existing API contract).
// Returns null if path is empty (root) or the folder doesn't exist.
async function folderIdForPath(
  db: D1Database,
  workspaceId: string,
  folderPath: string,
): Promise<{ folderId: string | null; missing: boolean }> {
  const normalized = folderPath.replace(/^\/+|\/+$/g, "");
  if (!normalized) return { folderId: null, missing: false };
  const withSlash = `/${normalized}`;
  const row = await db
    .prepare("SELECT id FROM folders WHERE workspace_id = ?1 AND path = ?2")
    .bind(workspaceId, withSlash)
    .first<{ id: string }>();
  if (!row) return { folderId: null, missing: true };
  return { folderId: row.id, missing: false };
}

async function rowToRecord(db: D1Database, row: PageRow): Promise<PageRecord> {
  const folderPath = await folderPathForId(db, row.folder_id);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    folderPath,
    title: row.title,
    slug: row.slug,
    slugId: row.slug_id,
    sourceType: normalizeSourceType(row.source_type),
    objectKeyCurrent: row.object_key_current,
    contentHash: row.content_hash,
    versionId: row.version_id ?? "",
    renderedArtifactKey: row.rendered_artifact_key,
    deletedAt: row.deleted_at,
    deletedByUserId: row.deleted_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: PageVersionRow): PageVersionRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    workspaceId: row.workspace_id,
    objectKey: row.object_key,
    sourceHash: row.source_hash,
    sourceType: normalizeSourceType(row.source_type),
    label: row.label,
    createdReason: row.created_reason as PageVersionRecord["createdReason"],
    createdAt: row.created_at,
  };
}

async function fetchPageRow(
  ctx: ServiceContext,
  pageId: string,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): Promise<PageRow | null> {
  const db = requireDb(ctx);
  const query = includeDeleted
    ? `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?1`
    : `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?1 AND deleted_at IS NULL`;
  const row = await db.prepare(query).bind(pageId).first<PageRow>();
  return row ?? null;
}

async function fetchPageRowBySlug(
  ctx: ServiceContext,
  slugId: string,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): Promise<PageRow | null> {
  const db = requireDb(ctx);
  const sql = includeDeleted
    ? `SELECT ${PAGE_COLUMNS} FROM pages WHERE slug_id = ?1`
    : `SELECT ${PAGE_COLUMNS} FROM pages WHERE slug_id = ?1 AND deleted_at IS NULL`;
  const row = await db.prepare(sql).bind(slugId).first<PageRow>();
  return row ?? null;
}

async function loadSource(ctx: ServiceContext, row: PageRow): Promise<string> {
  const objectStore = requireObjectStore(ctx);
  const stored = await objectStore.get(row.object_key_current);
  if (!stored) {
    throw new ServiceError("NOT_FOUND", "Page source object was not found.", {
      object_key: row.object_key_current,
    });
  }
  return stored.body;
}

async function nextPosition(
  db: D1Database,
  workspaceId: string,
  folderId: string | null,
): Promise<number> {
  // pages_workspace_folder_position_idx filters deleted_at IS NULL — we
  // mirror that so the position calc doesn't consider tombstones.
  const row = folderId
    ? await db
        .prepare(
          `SELECT COALESCE(MAX(position), 0) AS max_pos FROM pages
            WHERE workspace_id = ?1 AND folder_id = ?2 AND deleted_at IS NULL`,
        )
        .bind(workspaceId, folderId)
        .first<{ max_pos: number }>()
    : await db
        .prepare(
          `SELECT COALESCE(MAX(position), 0) AS max_pos FROM pages
            WHERE workspace_id = ?1 AND folder_id IS NULL AND deleted_at IS NULL`,
        )
        .bind(workspaceId)
        .first<{ max_pos: number }>();
  return (row?.max_pos ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Resolve a page by slug_id or pg_* id transparently. Both refs are
// accepted everywhere the user/agent supplies a page reference.
export async function getByRef(
  ctx: ServiceContext,
  ref: string,
): Promise<PageWithSource | null> {
  if (!ref) return null;
  // Try slug_id first (cheaper index lookup), fall back to id. Either
  // way, deleted_at filter applies — a tombstoned page is invisible.
  const row =
    (await fetchPageRowBySlug(ctx, ref)) ?? (await fetchPageRow(ctx, ref));
  if (!row) return null;
  const db = requireDb(ctx);
  const page = await rowToRecord(db, row);
  const source = await loadSource(ctx, row);
  return { page, source };
}

// Read a page by id (with source). Returns null if missing or
// soft-deleted. Pass `{ includeDeleted: true }` to also load trashed
// pages — used by the trash + restore + hardDelete routes.
export async function get(
  ctx: ServiceContext,
  pageId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<PageWithSource | null> {
  const row = await fetchPageRow(ctx, pageId, {
    includeDeleted: options.includeDeleted ?? false,
  });
  if (!row) return null;
  const db = requireDb(ctx);
  return {
    page: await rowToRecord(db, row),
    source: await loadSource(ctx, row),
  };
}

// Read a page by slug_id (with source). Returns null if missing or
// soft-deleted. Pass `{ includeDeleted: true }` to also surface
// trashed pages — the /p/:slug route uses this to render a friendly
// "this page is in the trash" panel for logged-in workspace
// editors while still showing a generic 404 to anonymous visitors.
export async function getBySlugId(
  ctx: ServiceContext,
  slugId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<PageWithSource | null> {
  const row = await fetchPageRowBySlug(ctx, slugId, {
    includeDeleted: options.includeDeleted ?? false,
  });
  if (!row) return null;
  const db = requireDb(ctx);
  return {
    page: await rowToRecord(db, row),
    source: row.deleted_at ? "" : await loadSource(ctx, row),
  };
}

// List every (non-deleted) page in a workspace. When workspaceId is
// omitted, returns every page across every workspace — used by the
// in-memory parity tests; production callers always pass a workspaceId.
// Hard cap on rows returned by list endpoints. Large workspaces can
// accumulate tens of thousands of pages; without a LIMIT a single
// public render could fan out hundreds of subrequests and exhaust the
// Worker CPU budget. Callers that need to walk past the cap should
// use `listPaginated` and follow the returned cursor.
const LIST_HARD_CAP = 2000;
const LIST_DEFAULT_LIMIT = 500;

export type ListOptions = {
  // Page size. Clamped to [1, LIST_HARD_CAP]. Defaults to
  // LIST_DEFAULT_LIMIT (500) when unspecified.
  limit?: number;
};

// Project a batch of PageRow into PageRecord, resolving the folder
// path for each row via a single batched D1 lookup so we don't fire
// N+1 reads in the common case where pages reference many folders.
async function rowsToPageRecords(
  db: ReturnType<typeof requireDb>,
  rows: PageRow[],
): Promise<PageRecord[]> {
  const folderIds = [
    ...new Set(
      rows.map((r) => r.folder_id).filter((id): id is string => Boolean(id)),
    ),
  ];
  const pathByFolderId = new Map<string, string>();
  if (folderIds.length > 0) {
    const placeholders = folderIds.map((_, i) => `?${i + 1}`).join(",");
    const folders = d1AllRows(
      await db
        .prepare(`SELECT id, path FROM folders WHERE id IN (${placeholders})`)
        .bind(...folderIds)
        .all<{ id: string; path: string }>(),
    );
    for (const folder of folders) {
      pathByFolderId.set(folder.id, folder.path.replace(/^\/+/, ""));
    }
  }
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    folderPath: row.folder_id ? (pathByFolderId.get(row.folder_id) ?? "") : "",
    title: row.title,
    slug: row.slug,
    slugId: row.slug_id,
    sourceType: normalizeSourceType(row.source_type),
    objectKeyCurrent: row.object_key_current,
    contentHash: row.content_hash,
    versionId: row.version_id ?? "",
    renderedArtifactKey: row.rendered_artifact_key,
    deletedAt: row.deleted_at,
    deletedByUserId: row.deleted_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function list(
  ctx: ServiceContext,
  workspaceId?: string,
  options: ListOptions = {},
): Promise<PageRecord[]> {
  const db = requireDb(ctx);
  const limit = Math.min(
    LIST_HARD_CAP,
    Math.max(1, Math.floor(options.limit ?? LIST_DEFAULT_LIMIT)),
  );
  const result = workspaceId
    ? await db
        .prepare(
          `SELECT ${PAGE_COLUMNS} FROM pages
            WHERE workspace_id = ?1 AND deleted_at IS NULL
            ORDER BY updated_at DESC, id ASC
            LIMIT ?2`,
        )
        .bind(workspaceId, limit)
        .all<PageRow>()
    : await db
        .prepare(
          `SELECT ${PAGE_COLUMNS} FROM pages
            WHERE deleted_at IS NULL
            ORDER BY workspace_id ASC, updated_at DESC, id ASC
            LIMIT ?1`,
        )
        .bind(limit)
        .all<PageRow>();
  return rowsToPageRecords(db, d1AllRows(result));
}

// Cursor-paginated list. Cursor encodes `(updated_at, id)` so resumes
// are stable across rows with identical updated_at timestamps. Returns
// the page of results plus `nextCursor` (null when the current page
// fits within `limit + 1` rows, indicating no more data).
//
// Why a separate function instead of overloading `list`: this returns
// an envelope `{items, nextCursor}` rather than a bare array, so every
// caller must be paginated-aware. Mixing the two via overloads
// reliably breaks at least one caller per refactor; this is cleaner.
export async function listPaginated(
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    limit?: number;
    cursor?: string;
  },
): Promise<PaginatedResult<PageRecord>> {
  const db = requireDb(ctx);
  const limit = clampLimit(input.limit, {
    default: LIST_DEFAULT_LIMIT,
    hardCap: LIST_HARD_CAP,
  });
  const cursor = decodeCursor(input.cursor);
  // Fetch `limit + 1` so we can detect whether there's another page
  // without a separate count query. The extra row is dropped from
  // `items` and used only to derive `nextCursor`.
  const fetchLimit = limit + 1;
  const result = cursor
    ? // Strict-less-than to skip the row that produced the previous
      // cursor; ties on updated_at break on id so the order is total.
      await db
        .prepare(
          `SELECT ${PAGE_COLUMNS} FROM pages
            WHERE workspace_id = ?1 AND deleted_at IS NULL
              AND (updated_at < ?2 OR (updated_at = ?2 AND id > ?3))
            ORDER BY updated_at DESC, id ASC
            LIMIT ?4`,
        )
        .bind(input.workspaceId, cursor.updatedAt, cursor.id, fetchLimit)
        .all<PageRow>()
    : await db
        .prepare(
          `SELECT ${PAGE_COLUMNS} FROM pages
            WHERE workspace_id = ?1 AND deleted_at IS NULL
            ORDER BY updated_at DESC, id ASC
            LIMIT ?2`,
        )
        .bind(input.workspaceId, fetchLimit)
        .all<PageRow>();
  const rows = d1AllRows(result);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await rowsToPageRecords(db, pageRows);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ updatedAt: last.updated_at, id: last.id })
      : null;
  return { items, nextCursor };
}

export async function create(
  ctx: ServiceContext,
  input: CreatePageInput,
): Promise<ServiceOutput<PageWithSource>> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);

  const title = input.title?.trim() || "Untitled";
  const sourceType: SourceType = input.sourceType ?? "markdown";
  // The page row already carries the title; strip a leading
  // `# {title}` (markdown/mdx) or `<h1>{title}</h1>` (html) from the
  // source so the rendered surfaces and editor don't display the
  // title twice. Templates ship `# {{ title }}` at the top, the web
  // "new page" dialog seeds the title into the body, and CLI users
  // habitually paste the title as their first heading — all three
  // paths funnel through this strip.
  const source = stripLeadingTitleFromSource(
    input.source ?? "",
    title,
    sourceType,
  );

  const id = input.id ?? createId(idPrefixes.page);
  const slug = slugifyTitle(title);
  const slugId = makePageSlugId(title, id);
  const versionId = createId(idPrefixes.version);
  const contentHash = await sha256Hex(source);
  const objectKey = buildObjectKey(
    input.workspaceId,
    id,
    contentHash,
    sourceType,
  );
  const now = new Date().toISOString();
  const createdBy = ctx.actor.userId || null;

  // Folder lookup. The caller passes a folder *path* (legacy contract);
  // we resolve to the folder_id the schema expects. An empty path means
  // root (folder_id IS NULL); a non-empty path that doesn't resolve is
  // a 404. Routes also validate this — we double-check so MCP and CLI
  // callers can't slip a bad folder past us.
  const folderPath = (input.folderPath ?? "").replace(/^\/+|\/+$/g, "");
  const { folderId, missing: folderMissing } = await folderIdForPath(
    db,
    input.workspaceId,
    folderPath,
  );
  if (folderMissing) {
    throw new ServiceError(
      "NOT_FOUND",
      "Folder was not found in this workspace.",
      { folder_path: folderPath },
    );
  }

  const position = await nextPosition(db, input.workspaceId, folderId);
  const flags = scanFlags(source, sourceType);

  // Write the blob first so a D1 row never points at a missing object.
  // Same-bytes put() is an idempotent overwrite — safe.
  await objectStore.put(objectKey, source, {
    contentType: contentTypeFor(sourceType),
  });

  // INSERT page row + initial page_versions row in one batch so they
  // either both land or both roll back. If the batch throws (FK
  // collision, transient D1 outage), schedule R2 cleanup of the
  // just-written source blob via ctx.waitUntil so we don't leak.
  try {
    await runBatch(db, [
      db
        .prepare(
          `INSERT INTO pages
           (id, workspace_id, folder_id, title, slug, slug_id, source_type,
            object_key_current, frontmatter_json, content_hash, version_id,
            position,
            has_code, has_mermaid, has_math, has_wardley, has_cytoscape, has_iframe,
            rendered_artifact_key, deleted_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                 ?8, '{}', ?9, ?10,
                 ?11,
                 ?12, ?13, ?14, ?15, ?16, ?17,
                 NULL, NULL, ?18, ?18)`,
        )
        .bind(
          id,
          input.workspaceId,
          folderId,
          title,
          slug,
          slugId,
          sourceType,
          objectKey,
          contentHash,
          versionId,
          position,
          flags.has_code,
          flags.has_mermaid,
          flags.has_math,
          flags.has_wardley,
          flags.has_cytoscape,
          flags.has_iframe,
          now,
        ),
      db
        .prepare(
          `INSERT INTO page_versions
           (id, page_id, workspace_id, object_key, source_hash, source_type,
            label, created_reason, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'system', ?8, ?9)`,
        )
        .bind(
          versionId,
          id,
          input.workspaceId,
          objectKey,
          contentHash,
          sourceType,
          "Initial version",
          createdBy,
          now,
        ),
    ]);
  } catch (createError) {
    ctx.waitUntil(
      Promise.resolve().then(async () => {
        try {
          await objectStore.delete(objectKey);
        } catch {
          // R2 lifecycle rule is the backstop.
        }
      }),
    );
    throw createError;
  }

  const page: PageRecord = {
    id,
    workspaceId: input.workspaceId,
    folderPath,
    title,
    slug,
    slugId,
    sourceType,
    objectKeyCurrent: objectKey,
    contentHash,
    versionId,
    renderedArtifactKey: null,
    deletedAt: null,
    deletedByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
  const treeVersion = await ctx.computeTreeVersion(input.workspaceId);
  return {
    data: { page, source },
    envelope: buildEnvelope({
      treeVersion,
      contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${id}`],
    }),
  };
}

export async function updateSource(
  ctx: ServiceContext,
  input: UpdateSourceInput,
): Promise<ServiceOutput<UpdateSourceResult>> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);

  if (!input.baseVersionId) {
    throw new ServiceError(
      "VALIDATION",
      "baseVersionId is required for optimistic concurrency.",
    );
  }

  // Pull the row up-front so we know the existing source type +
  // object_key for the page_versions audit row. We do NOT use this row
  // to gate the write — the gate is the WHERE version_id = ? on the
  // UPDATE below. Reading first only buys us the metadata.
  const existing = await fetchPageRow(ctx, input.pageId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  const sourceType = normalizeSourceType(existing.source_type);
  const previousObjectKey = existing.object_key_current;
  const previousContentHash = existing.content_hash;
  const previousVersionId = existing.version_id ?? "";

  // Strip the leading title H1 if the caller accidentally re-introduced
  // it (templates, agent prose drafted as "# {title}\n\nbody", etc.).
  // The row's `title` field stays the single source of truth.
  const normalizedSource = stripLeadingTitleFromSource(
    input.source,
    existing.title,
    sourceType,
  );
  const newContentHash = await sha256Hex(normalizedSource);
  const changed = newContentHash !== previousContentHash;

  // Note: we want updateSource(samesource) to still bump updated_at so
  // checkpoint=true callers can record a manual snapshot of unchanged
  // content. The version_id only advances when content actually changes
  // OR an explicit checkpoint is requested.
  const newVersionId =
    changed || input.checkpoint
      ? createId(idPrefixes.version)
      : previousVersionId;
  const newObjectKey = changed
    ? buildObjectKey(
        existing.workspace_id,
        existing.id,
        newContentHash,
        sourceType,
      )
    : previousObjectKey;
  const flags = scanFlags(normalizedSource, sourceType);
  const now = new Date().toISOString();

  // Write the new blob first when the bytes changed. Same-bytes saves
  // (changed=false + checkpoint=true) reuse the existing object — no
  // put needed. If the D1 UPDATE below detects a CONFLICT (concurrent
  // writer won the race), we roll back this R2 put via the catch
  // branch so we don't accumulate orphan source blobs.
  if (changed) {
    await objectStore.put(newObjectKey, normalizedSource, {
      contentType: contentTypeFor(sourceType),
    });
  }

  function scheduleSourceRollback(): void {
    if (!changed) return;
    ctx.waitUntil(
      Promise.resolve().then(async () => {
        try {
          await objectStore.delete(newObjectKey);
        } catch {
          // Orphan: D1 update aborted and R2 cleanup also failed.
          // The R2 lifecycle policy is the final backstop.
        }
      }),
    );
  }

  // Atomic UPDATE … WHERE version_id = ? RETURNING …  No row matches
  // means a concurrent updateSource won the race — surface CONFLICT.
  // (CONFLICT maps to HTTP 409; clients read err.code to drive retry.)
  // SQLite has no boolean — we rely on the missing-row signal.
  // The WHERE deleted_at IS NULL guard prevents resurrecting a
  // soft-deleted page via a stale baseVersionId.
  const updated = previousVersionId
    ? await db
        .prepare(
          `UPDATE pages
              SET object_key_current = ?1,
                  content_hash = ?2,
                  version_id = ?3,
                  has_code = ?4, has_mermaid = ?5, has_math = ?6,
                  has_wardley = ?7, has_cytoscape = ?8, has_iframe = ?9,
                  updated_at = ?10
            WHERE id = ?11 AND version_id = ?12 AND deleted_at IS NULL
        RETURNING ${PAGE_COLUMNS}`,
        )
        .bind(
          newObjectKey,
          newContentHash,
          newVersionId,
          flags.has_code,
          flags.has_mermaid,
          flags.has_math,
          flags.has_wardley,
          flags.has_cytoscape,
          flags.has_iframe,
          now,
          input.pageId,
          input.baseVersionId,
        )
        .first<PageRow>()
    : // Legacy rows with NULL version_id. We can't gate on the column
      // directly (SQLite treats NULL = NULL as NULL/false). Treat the
      // baseVersionId as advisory — match on id alone but still surface
      // CONFLICT if the row vanished. Production pages always have a
      // version_id; this only matters for partially-migrated data.
      await db
        .prepare(
          `UPDATE pages
              SET object_key_current = ?1,
                  content_hash = ?2,
                  version_id = ?3,
                  has_code = ?4, has_mermaid = ?5, has_math = ?6,
                  has_wardley = ?7, has_cytoscape = ?8, has_iframe = ?9,
                  updated_at = ?10
            WHERE id = ?11 AND deleted_at IS NULL
        RETURNING ${PAGE_COLUMNS}`,
        )
        .bind(
          newObjectKey,
          newContentHash,
          newVersionId,
          flags.has_code,
          flags.has_mermaid,
          flags.has_math,
          flags.has_wardley,
          flags.has_cytoscape,
          flags.has_iframe,
          now,
          input.pageId,
        )
        .first<PageRow>();

  if (!updated) {
    // Concurrent writer won the version_id race. Roll back the R2
    // source blob we just wrote so we don't leave orphan bytes on
    // every conflict, then surface CONFLICT to the client.
    scheduleSourceRollback();
    throw new ServiceError(
      "CONFLICT",
      "Page source has changed since it was loaded.",
      {
        current_version_id: previousVersionId,
        current_content_hash: previousContentHash,
      },
    );
  }

  // Append a page_versions row when:
  //   - the bytes actually changed (every save is a version), OR
  //   - the caller requested a manual checkpoint of unchanged content.
  // For changed content the row records the NEW source. For an explicit
  // checkpoint on unchanged content the row also records the existing
  // source under the new version id so history viewers see the marker.
  // page_versions is an audit/history table — its FK is to pages.id
  // (not pages.version_id), so even if this INSERT fails, the page row
  // stays internally consistent. We log + best-effort retry rather
  // than fail the whole save.
  const checkpointCreated = changed || Boolean(input.checkpoint);
  if (checkpointCreated) {
    try {
      await db
        .prepare(
          `INSERT INTO page_versions
           (id, page_id, workspace_id, object_key, source_hash, source_type,
            label, created_reason, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          newVersionId,
          existing.id,
          existing.workspace_id,
          newObjectKey,
          newContentHash,
          sourceType,
          input.checkpointLabel ?? null,
          input.checkpoint ? "manual" : "system",
          ctx.actor.userId || null,
          now,
        )
        .run();
    } catch (versionInsertError) {
      // Page row already committed with the new version_id — the audit
      // row is the only thing missing. Don't fail the user's save;
      // surface the inconsistency for offline reconciliation. Search
      // and history may show one fewer historical entry until manual
      // backfill, but reads remain correct.
      ctx.log("error", "page.version.insert.failed", {
        page_id: existing.id,
        version_id: newVersionId,
        content_hash: newContentHash,
        error: String(versionInsertError),
      });
    }
  }

  const page = await rowToRecord(db, updated);

  // Save-time render → R2 → pages.rendered_artifact_key → publish
  // fan-out. Plan 011 §6 + §7. Both the render itself and the
  // downstream publish fan-out are scheduled via ctx.waitUntil so the
  // save endpoint returns as soon as the source + version rows are
  // durable. The /p/{slug} SSR fallback (republishOnDemand in
  // publication-cache.ts) covers anonymous reads that race the
  // in-flight render. The save response intentionally omits
  // `renderedArtifactKey` — that pointer is eventually consistent.
  if (changed) {
    const workspaceId = existing.workspace_id;
    const pageId = existing.id;
    const sourceBytes = normalizedSource;
    const contentHash = newContentHash;
    const renderedKey = `pages/${workspaceId}/${pageId}/rendered-${contentHash}.html`;
    ctx.waitUntil(
      (async () => {
        try {
          const rendered = await renderAtSave({
            source: sourceBytes,
            sourceType,
          });
          await objectStore.put(renderedKey, rendered.html, {
            contentType: "text/html; charset=utf-8",
          });
          try {
            await db
              .prepare(
                `UPDATE pages SET rendered_artifact_key = ?2 WHERE id = ?1`,
              )
              .bind(pageId, renderedKey)
              .run();
          } catch (renderedUpdateError) {
            // D1 pointer write failed after R2 put — schedule R2
            // cleanup so we don't leak the orphan. The source +
            // page row are already durable, so the next save will
            // re-render fresh.
            try {
              await objectStore.delete(renderedKey);
            } catch {
              // R2 lifecycle rule is the backstop.
            }
            ctx.log("error", "render.atSave.pointer.failed", {
              page_id: pageId,
              content_hash: contentHash,
              error: String(renderedUpdateError),
            });
            return;
          }
          // Fan-out follows in the same waitUntil — publishFanOut
          // copies the rendered artifact to the publication's
          // `pub/{publicationId}/{hash}.html` slot and purges the
          // edge cache for /p/{slug}.
          const publication = await publications.findForResource(ctx, {
            workspaceId,
            resourceType: "page",
            resourceId: pageId,
          });
          if (publication && !publication.revokedAt) {
            try {
              await publications.publishFanOut(ctx, {
                publicationId: publication.id,
                workspaceId,
                pageId,
                contentHash,
              });
            } catch (fanOutError) {
              ctx.log("warn", "publish.fanout.failed", {
                page_id: pageId,
                publication_id: publication.id,
                error: String(fanOutError),
              });
            }
          }
        } catch (renderError) {
          // Render itself failed (shiki/sanitize/etc). Source bytes
          // are already durable in R2 + D1 — only the rendered
          // artifact is missing. /p/[slug] republishOnDemand kicks
          // in on the next anonymous read.
          ctx.log("error", "render.atSave.failed", {
            page_id: pageId,
            content_hash: contentHash,
            source_type: sourceType,
            error: String(renderError),
          });
        }
      })(),
    );
  }

  const treeVersion = await ctx.computeTreeVersion(page.workspaceId);
  return {
    data: { page, changed, checkpointCreated },
    envelope: buildEnvelope({
      treeVersion,
      contentHash: page.contentHash,
      // Source change can flip the title (via frontmatter), so the
      // sidebar may need to refresh even though no row was added.
      navigationInvalidated: changed,
      changedResources: [`page:${page.id}`],
    }),
  };
}

export async function move(
  ctx: ServiceContext,
  input: MovePageInput,
): Promise<ServiceOutput<PageRecord>> {
  const db = requireDb(ctx);

  const existing = await fetchPageRow(ctx, input.pageId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }

  // Resolve the destination folder. undefined → keep current; "" → root;
  // any other string → look up by path.
  let nextFolderId: string | null = existing.folder_id;
  let nextFolderPath = await folderPathForId(db, existing.folder_id);
  if (input.folderPath !== undefined) {
    const normalized = input.folderPath.replace(/^\/+|\/+$/g, "");
    if (!normalized) {
      nextFolderId = null;
      nextFolderPath = "";
    } else {
      const { folderId, missing } = await folderIdForPath(
        db,
        existing.workspace_id,
        normalized,
      );
      if (missing) {
        throw new ServiceError(
          "NOT_FOUND",
          "Folder was not found in this workspace.",
          { folder_path: normalized },
        );
      }
      nextFolderId = folderId;
      nextFolderPath = normalized;
    }
  }

  const title = input.title?.trim() || existing.title;
  const slug = slugifyTitle(title);
  const slugId = makePageSlugId(title, existing.id);
  const position =
    nextFolderId === existing.folder_id
      ? existing.position
      : await nextPosition(db, existing.workspace_id, nextFolderId);
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE pages
          SET folder_id = ?1, title = ?2, slug = ?3, slug_id = ?4,
              position = ?5, updated_at = ?6
        WHERE id = ?7 AND deleted_at IS NULL`,
    )
    .bind(nextFolderId, title, slug, slugId, position, now, existing.id)
    .run();

  const page: PageRecord = {
    id: existing.id,
    workspaceId: existing.workspace_id,
    folderPath: nextFolderPath,
    title,
    slug,
    slugId,
    sourceType: normalizeSourceType(existing.source_type),
    objectKeyCurrent: existing.object_key_current,
    contentHash: existing.content_hash,
    versionId: existing.version_id ?? "",
    renderedArtifactKey: existing.rendered_artifact_key,
    deletedAt: existing.deleted_at,
    deletedByUserId: existing.deleted_by_user_id,
    createdAt: existing.created_at,
    updatedAt: now,
  };
  const treeVersion = await ctx.computeTreeVersion(page.workspaceId);
  return {
    data: page,
    envelope: buildEnvelope({
      treeVersion,
      contentHash: page.contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${page.id}`],
    }),
  };
}

export async function softDelete(
  ctx: ServiceContext,
  pageId: string,
): Promise<ServiceOutput<PageRecord>> {
  const db = requireDb(ctx);
  const existing = await fetchPageRow(ctx, pageId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  const now = new Date().toISOString();
  // Cascade revoke the page's publication (if any). Go through the
  // canonical publications.revoke path so latest_artifact_key is
  // nulled, the R2 artifact is scheduled for deletion, and the route
  // layer's cache invalidation hook is triggered uniformly. Without
  // this cascade the /p/{slug} fast-path keeps serving the artifact
  // for a deleted page — full workspace content leak.
  const publication = await publications.findForResource(ctx, {
    workspaceId: existing.workspace_id,
    resourceType: "page",
    resourceId: pageId,
  });
  if (publication && !publication.revokedAt) {
    await publications.revoke(ctx, publication.id);
  }
  const actorUserId = ctx.actor.userId || null;
  await db
    .prepare(
      "UPDATE pages SET deleted_at = ?1, deleted_by_user_id = ?2, updated_at = ?1 WHERE id = ?3 AND deleted_at IS NULL",
    )
    .bind(now, actorUserId, pageId)
    .run();

  const page: PageRecord = await rowToRecord(db, {
    ...existing,
    deleted_at: now,
    deleted_by_user_id: actorUserId,
    updated_at: now,
  });
  const treeVersion = await ctx.computeTreeVersion(page.workspaceId);
  return {
    data: page,
    envelope: buildEnvelope({
      treeVersion,
      contentHash: page.contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${page.id}`],
    }),
  };
}

export async function restore(
  ctx: ServiceContext,
  pageId: string,
): Promise<ServiceOutput<PageRecord>> {
  const db = requireDb(ctx);
  // Read including deleted so a previously soft-deleted page becomes
  // visible again.
  const existing = await fetchPageRow(ctx, pageId, { includeDeleted: true });
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE pages SET deleted_at = NULL, deleted_by_user_id = NULL, updated_at = ?1 WHERE id = ?2",
    )
    .bind(now, pageId)
    .run();

  const page = await rowToRecord(db, {
    ...existing,
    deleted_at: null,
    deleted_by_user_id: null,
    updated_at: now,
  });
  const treeVersion = await ctx.computeTreeVersion(page.workspaceId);
  return {
    data: page,
    envelope: buildEnvelope({
      treeVersion,
      contentHash: page.contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${page.id}`],
    }),
  };
}

// Hard-delete: only callable AFTER a soft-delete (so we never bypass the
// trash window). Drops the D1 row (page_versions cascade via FK), the R2
// source blob, and the rendered artifact. Audit row + review event so
// reviewers polling wait_for_review notice the disappearance.
export async function hardDelete(
  ctx: ServiceContext,
  pageId: string,
): Promise<{ workspaceId: string; pageId: string }> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);
  const existing = await fetchPageRow(ctx, pageId, { includeDeleted: true });
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  if (!existing.deleted_at) {
    throw new ServiceError(
      "VALIDATION",
      "Page must be soft-deleted (in trash) before it can be permanently deleted.",
    );
  }

  // Snapshot version object keys before the FK cascade nukes the rows.
  const versions = await db
    .prepare("SELECT object_key FROM page_versions WHERE page_id = ?1")
    .bind(pageId)
    .all<{ object_key: string }>();
  const versionKeys = d1AllRows(versions).map((row) => row.object_key);

  // Snapshot publication R2 artifact keys (if any) and drop the
  // publication row. `publications.resource_id` is a plain TEXT
  // column with no FK to pages.id, so the cascade DELETE below
  // would otherwise leave an orphan publications row pointing at
  // a missing page. softDelete already revoked the publication
  // (set revoked_at and scheduled R2 cleanup), but the row itself
  // stays until we drop it here.
  const pubArtifactKeys: string[] = [];
  const pubRows = await db
    .prepare(
      `SELECT id, latest_artifact_key FROM publications
        WHERE workspace_id = ?1 AND resource_type = 'page' AND resource_id = ?2`,
    )
    .bind(existing.workspace_id, pageId)
    .all<{ id: string; latest_artifact_key: string | null }>();
  for (const row of d1AllRows(pubRows)) {
    if (row.latest_artifact_key) pubArtifactKeys.push(row.latest_artifact_key);
  }
  await db
    .prepare(
      `DELETE FROM publications
        WHERE workspace_id = ?1 AND resource_type = 'page' AND resource_id = ?2`,
    )
    .bind(existing.workspace_id, pageId)
    .run();

  // DELETE FROM pages cascades to page_versions via FK.
  await db.prepare("DELETE FROM pages WHERE id = ?1").bind(pageId).run();

  // Best-effort object-store cleanup. R2 lifecycle policies are the
  // final backstop if any of these fail.
  const keysToDrop = new Set<string>();
  keysToDrop.add(existing.object_key_current);
  if (existing.rendered_artifact_key) {
    keysToDrop.add(existing.rendered_artifact_key);
  }
  for (const key of versionKeys) keysToDrop.add(key);
  for (const key of pubArtifactKeys) keysToDrop.add(key);
  for (const key of keysToDrop) {
    try {
      await objectStore.delete(key);
    } catch (error) {
      ctx.log("warn", "page.hard_delete.object_cleanup_failed", {
        page_id: pageId,
        key,
        error: String(error),
      });
    }
  }
  return { workspaceId: existing.workspace_id, pageId };
}

export interface TrashedPageRecord {
  pageId: string;
  workspaceId: string;
  title: string;
  folderPath: string;
  slug: string;
  slugId: string;
  sourceType: SourceType;
  deletedAt: string;
  deletedByUserId: string | null;
}

// List soft-deleted pages in a workspace. `scope: "mine"` filters to
// pages the supplied userId trashed; `scope: "workspace"` returns all.
export async function listTrashed(
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    scope: "mine" | "workspace";
    userId?: string | null;
  },
): Promise<TrashedPageRecord[]> {
  const db = requireDb(ctx);
  if (input.scope === "mine" && !input.userId) return [];
  const sql =
    input.scope === "mine"
      ? `SELECT p.id, p.workspace_id, p.title, p.folder_id, p.slug, p.slug_id,
                p.source_type, p.deleted_at, p.deleted_by_user_id,
                f.path as folder_path
         FROM pages p
         LEFT JOIN folders f ON f.id = p.folder_id
         WHERE p.workspace_id = ?1
           AND p.deleted_at IS NOT NULL
           AND p.deleted_by_user_id = ?2
         ORDER BY p.deleted_at DESC`
      : `SELECT p.id, p.workspace_id, p.title, p.folder_id, p.slug, p.slug_id,
                p.source_type, p.deleted_at, p.deleted_by_user_id,
                f.path as folder_path
         FROM pages p
         LEFT JOIN folders f ON f.id = p.folder_id
         WHERE p.workspace_id = ?1
           AND p.deleted_at IS NOT NULL
         ORDER BY p.deleted_at DESC`;
  const stmt =
    input.scope === "mine"
      ? db.prepare(sql).bind(input.workspaceId, input.userId)
      : db.prepare(sql).bind(input.workspaceId);
  const raw = await stmt.all<{
    id: string;
    workspace_id: string;
    title: string;
    folder_id: string | null;
    slug: string;
    slug_id: string;
    source_type: string;
    deleted_at: string;
    deleted_by_user_id: string | null;
    folder_path: string | null;
  }>();
  return d1AllRows(raw).map((row) => ({
    pageId: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    folderPath: row.folder_path ?? "",
    slug: row.slug,
    slugId: row.slug_id,
    sourceType: normalizeSourceType(row.source_type),
    deletedAt: row.deleted_at,
    deletedByUserId: row.deleted_by_user_id,
  }));
}

// Returns the count of pages whose deleted_at is older than the cutoff
// ISO timestamp. Used by the auto-purge cron job to know how much to
// process; the cron then calls hardDelete for each id.
export async function listExpiredTrashedIds(
  ctx: ServiceContext,
  input: { olderThan: string; limit: number },
): Promise<string[]> {
  const db = requireDb(ctx);
  const raw = await db
    .prepare(
      `SELECT id FROM pages
        WHERE deleted_at IS NOT NULL
          AND deleted_at < ?1
        ORDER BY deleted_at ASC
        LIMIT ?2`,
    )
    .bind(input.olderThan, input.limit)
    .all<{ id: string }>();
  return d1AllRows(raw).map((row) => row.id);
}

export async function listVersions(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<PageVersionRecord[]> {
  const db = requireDb(ctx);
  const result = await db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM page_versions
        WHERE page_id = ?1
        ORDER BY created_at DESC, id DESC`,
    )
    .bind(input.pageId)
    .all<PageVersionRow>();
  return d1AllRows(result).map(rowToVersion);
}

export async function getVersionSource(
  ctx: ServiceContext,
  input: { pageId: string; versionId: string },
): Promise<{ version: PageVersionRecord; source: string }> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);
  const row = await db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM page_versions
        WHERE id = ?1 AND page_id = ?2`,
    )
    .bind(input.versionId, input.pageId)
    .first<PageVersionRow>();
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Page version was not found.");
  }
  const stored = await objectStore.get(row.object_key);
  if (!stored) {
    throw new ServiceError(
      "NOT_FOUND",
      "Page version source object was not found.",
      { object_key: row.object_key },
    );
  }
  return { version: rowToVersion(row), source: stored.body };
}

// Restore a prior version by re-writing its source as the current
// source. Implemented as a wrapper around updateSource(checkpoint=true)
// so the optimistic-concurrency and history-recording guarantees are
// the same.
export async function restoreVersion(
  ctx: ServiceContext,
  input: { pageId: string; versionId: string },
): Promise<ServiceOutput<UpdateSourceResult>> {
  const existing = await fetchPageRow(ctx, input.pageId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  const version = await getVersionSource(ctx, {
    pageId: input.pageId,
    versionId: input.versionId,
  });
  return updateSource(ctx, {
    pageId: input.pageId,
    source: version.source,
    baseVersionId: existing.version_id ?? "",
    checkpoint: true,
    checkpointLabel: `Restored ${version.version.createdAt}`,
  });
}

// AppError is imported at the top to keep the existing public surface
// tests that match { code: "NOT_FOUND" } working without an instanceof
// check — ServiceError exposes `code` directly. The AppError import is
// kept available for future use; no current export depends on it.
void AppError;
