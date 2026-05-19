// Search service — direct-D1 over the `search_documents` table and its
// FTS5 mirror (`search_documents_fts`).
//
// Plan 011 §5. Replaces packages/core/src/search.ts (an in-memory
// class-based scorer) with plain async functions over ServiceContext
// that delegate matching to SQLite FTS5. The FTS5 mirror is kept in
// sync automatically by the search_documents_ai/au/ad triggers
// declared in packages/db/migrations/0001_init.sql — services here
// only ever read/write the base `search_documents` table.
//
// Authorization contract: routes are responsible for verifying the
// actor's read access to the workspace BEFORE invoking query() or
// listRecent(). Services here check only AUTHENTICATION-adjacent
// invariants (workspaceId/userId present, query non-empty).

import { requireDb, type ServiceContext } from "./context.ts";

export type SearchResourceType = "page" | "folder" | "comment_thread";

export type SearchDocument = {
  resourceType: SearchResourceType;
  resourceId: string;
  workspaceId: string;
  pageId: string | null;
  folderId: string | null;
  title: string;
  path: string;
  headingsText: string;
  frontmatterText: string;
  bodyText: string;
  commentText: string;
  tags: string;
  url: string;
  updatedAt: string;
};

export type SearchResult = {
  resourceType: SearchResourceType;
  resourceId: string;
  workspaceId: string;
  pageId: string | null;
  folderId: string | null;
  title: string;
  path: string;
  snippet: string;
  url: string;
  rank: number;
};

export type RecentResourceRecord = {
  resourceType: SearchResourceType;
  resourceId: string;
  lastOpenedAt: string;
};

export type ReconcileCounts = {
  pages: number;
  folders: number;
  comments: number;
};

// Normalize a resource_type string read back from the DB. The CHECK
// constraint already guarantees one of these three values, but typing
// it explicitly keeps the public API honest.
function normalizeResourceType(value: string): SearchResourceType {
  if (value === "folder") return "folder";
  if (value === "comment_thread") return "comment_thread";
  return "page";
}

// FTS5 query sanitization.
//
// FTS5 syntax recognizes a handful of operators (AND, OR, NOT, NEAR/,
// `*` for prefix, `"..."` for phrases). Untrusted user input can
// trivially break the parser ("foo:bar" → column filter error, an
// unbalanced quote → syntax error, etc.). Wrapping each token in
// double quotes and escaping embedded quotes by doubling makes every
// token a literal phrase. Multiple phrases default to AND.
//
// Empty input → empty string; callers short-circuit before binding.
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

// INSERT OR REPLACE into search_documents. The triggers
// (search_documents_au + search_documents_ai) mirror the new row into
// search_documents_fts automatically — we never touch the FTS table
// directly.
export async function index(
  ctx: ServiceContext,
  input: SearchDocument,
): Promise<void> {
  const db = requireDb(ctx);
  await db
    .prepare(
      `INSERT OR REPLACE INTO search_documents (
         resource_type, resource_id, workspace_id, page_id, folder_id,
         title, path, headings_text, frontmatter_text, body_text,
         comment_text, tags, url, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    .bind(
      input.resourceType,
      input.resourceId,
      input.workspaceId,
      input.pageId,
      input.folderId,
      input.title,
      input.path,
      input.headingsText,
      input.frontmatterText,
      input.bodyText,
      input.commentText,
      input.tags,
      input.url,
      input.updatedAt,
    )
    .run();
}

export async function remove(
  ctx: ServiceContext,
  input: { resourceType: SearchResourceType; resourceId: string },
): Promise<void> {
  const db = requireDb(ctx);
  await db
    .prepare(
      "DELETE FROM search_documents WHERE resource_type = ?1 AND resource_id = ?2",
    )
    .bind(input.resourceType, input.resourceId)
    .run();
}

// Cascade-style cleanup for a deleted page: drops the page's own
// search_doc AND any comment_thread docs that pointed at it.
export async function removeAllForPage(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<void> {
  const db = requireDb(ctx);
  await db
    .prepare(
      "DELETE FROM search_documents WHERE (resource_type = 'page' AND resource_id = ?1) OR (resource_type = 'comment_thread' AND page_id = ?1)",
    )
    .bind(input.pageId)
    .run();
}

// ---------------------------------------------------------------------------
// Scheduler helpers — collapse "fetch row + build SearchDocument + index"
// into a single call. Routes that mutate a page/folder/thread invoke
// these via ctx.waitUntil so the response path stays fast.
// ---------------------------------------------------------------------------

type PageIndexRow = {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  title: string;
  slug_id: string;
  source_type: string;
  object_key_current: string;
  frontmatter_json: string;
  deleted_at: string | null;
  updated_at: string;
};

// Strip HTML to a plain-text approximation so FTS can index user-
// visible words rather than tag soup. Cheap regex-based; intentionally
// not a full parser. Drops <script>/<style> blocks first so their
// contents never reach the index. Caller already enforces a content
// cap, so this runs in microseconds for typical pages.
function htmlToPlainText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

type FolderIndexRow = {
  id: string;
  workspace_id: string;
  parent_folder_id: string | null;
  name: string;
  slug_id: string;
  path: string;
  updated_at: string;
};

type ThreadIndexRow = {
  id: string;
  page_id: string;
  workspace_id: string;
  status: string;
  selected_text: string;
  created_at: string;
  updated_at: string;
};

function safeFrontmatterText(json: string): string {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return "";
    return Object.entries(parsed)
      .map(
        ([key, value]) =>
          `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`,
      )
      .join(" ");
  } catch {
    return "";
  }
}

// Re-index a page from its current D1 row. Reads the page + its source
// blob (for body text). Safe to call inside ctx.waitUntil — errors are
// swallowed so they don't poison the response.
export async function scheduleIndexPage(
  ctx: ServiceContext,
  pageId: string,
): Promise<void> {
  try {
    const db = requireDb(ctx);
    const row = await db
      .prepare(
        `SELECT id, workspace_id, folder_id, title, slug_id, source_type,
                object_key_current, frontmatter_json, deleted_at, updated_at
           FROM pages
          WHERE id = ?1`,
      )
      .bind(pageId)
      .first<PageIndexRow>();
    if (!row) return;
    if (row.deleted_at) {
      await remove(ctx, { resourceType: "page", resourceId: pageId });
      return;
    }
    // Best-effort source read. Read the page's CURRENT source object via
    // pages.object_key_current — that's the content-addressed key
    // (`pages/{ws}/{id}/source-{contentHash}.{ext}`) populated on every
    // save. The legacy `source-{updatedAt}.md` key was wrong on two
    // axes (hash vs timestamp, hard-coded `.md`) and resulted in body
    // text NEVER reaching the FTS index. For HTML sources we strip
    // tags so the index sees user-visible words.
    let bodyText = "";
    if (ctx.objectStore && row.object_key_current) {
      try {
        const obj = await ctx.objectStore.get(row.object_key_current);
        if (obj?.body) {
          bodyText =
            row.source_type === "html" ? htmlToPlainText(obj.body) : obj.body;
        }
      } catch {
        // Source blob lookup failed — body text is the empty string;
        // page is still searchable by title + headings.
      }
    }
    await index(ctx, {
      resourceType: "page",
      resourceId: row.id,
      workspaceId: row.workspace_id,
      pageId: row.id,
      folderId: row.folder_id,
      title: row.title,
      path: row.slug_id,
      headingsText: row.title,
      frontmatterText: safeFrontmatterText(row.frontmatter_json),
      bodyText,
      commentText: "",
      tags: "",
      url: `/p/${row.slug_id}`,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    ctx.log("warn", "search.scheduleIndexPage.failed", {
      page_id: pageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function scheduleIndexFolder(
  ctx: ServiceContext,
  folderId: string,
): Promise<void> {
  try {
    const db = requireDb(ctx);
    const row = await db
      .prepare(
        `SELECT id, workspace_id, parent_folder_id, name, slug_id, path, updated_at
           FROM folders
          WHERE id = ?1`,
      )
      .bind(folderId)
      .first<FolderIndexRow>();
    if (!row) return;
    await index(ctx, {
      resourceType: "folder",
      resourceId: row.id,
      workspaceId: row.workspace_id,
      pageId: null,
      folderId: row.id,
      title: row.name,
      path: row.path,
      headingsText: row.name,
      frontmatterText: "",
      bodyText: "",
      commentText: "",
      tags: "",
      url: `/f/${row.slug_id}`,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    ctx.log("warn", "search.scheduleIndexFolder.failed", {
      folder_id: folderId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function scheduleIndexCommentThread(
  ctx: ServiceContext,
  threadId: string,
): Promise<void> {
  try {
    const db = requireDb(ctx);
    const row = await db
      .prepare(
        `SELECT id, page_id, workspace_id, status, selected_text, created_at, updated_at
           FROM comment_threads
          WHERE id = ?1`,
      )
      .bind(threadId)
      .first<ThreadIndexRow>();
    if (!row) return;
    await index(ctx, {
      resourceType: "comment_thread",
      resourceId: row.id,
      workspaceId: row.workspace_id,
      pageId: row.page_id,
      folderId: null,
      title: row.selected_text.slice(0, 80),
      path: row.page_id,
      headingsText: "",
      frontmatterText: "",
      bodyText: "",
      commentText: row.selected_text,
      tags: row.status,
      url: `/p/${row.page_id}#thread-${row.id}`,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    ctx.log("warn", "search.scheduleIndexCommentThread.failed", {
      thread_id: threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function removeSearchResource(
  ctx: ServiceContext,
  input: { resourceType: SearchResourceType; resourceId: string },
): Promise<void> {
  try {
    await remove(ctx, input);
  } catch (error) {
    ctx.log("warn", "search.removeSearchResource.failed", {
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type FtsRow = {
  resource_type: string;
  resource_id: string;
  workspace_id: string;
  page_id: string | null;
  folder_id: string | null;
  title: string;
  path: string;
  snippet: string;
  url: string;
  rank: number;
};

export async function query(
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    query: string;
    limit?: number;
    resourceTypes?: SearchResourceType[];
  },
): Promise<SearchResult[]> {
  const db = requireDb(ctx);
  const ftsQuery = sanitizeFtsQuery(input.query);
  if (!ftsQuery) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));

  // We join FTS → base table so we can fetch the canonical `url`
  // (FTS doesn't index `url` — it's not searchable). snippet() picks
  // the body_text column (index 9 in the FTS column list) as that's
  // the longest text field and most useful for previews.
  //
  // Filter-by-type uses a small dynamic IN list. Inputs are
  // restricted to the SearchResourceType union via TypeScript, so the
  // values are safe to interpolate — but we still bind them to be
  // belt-and-braces.
  const typeFilter =
    input.resourceTypes && input.resourceTypes.length > 0
      ? input.resourceTypes
      : null;

  // Build positional placeholders for the type filter. Indices start
  // after the two fixed binds (ftsQuery, workspaceId).
  const typePlaceholders = typeFilter
    ? typeFilter.map((_, i) => `?${i + 3}`).join(", ")
    : null;

  const limitPlaceholder = `?${(typeFilter?.length ?? 0) + 3}`;

  const sql = `
    SELECT
      d.resource_type AS resource_type,
      d.resource_id AS resource_id,
      d.workspace_id AS workspace_id,
      d.page_id AS page_id,
      d.folder_id AS folder_id,
      d.title AS title,
      d.path AS path,
      snippet(search_documents_fts, 9, '[', ']', '...', 16) AS snippet,
      d.url AS url,
      fts.rank AS rank
    FROM search_documents_fts AS fts
    JOIN search_documents AS d
      ON d.resource_type = fts.resource_type
     AND d.resource_id = fts.resource_id
    WHERE search_documents_fts MATCH ?1
      AND d.workspace_id = ?2
      ${typePlaceholders ? `AND d.resource_type IN (${typePlaceholders})` : ""}
    ORDER BY fts.rank
    LIMIT ${limitPlaceholder}
  `;

  const binds: unknown[] = [ftsQuery, input.workspaceId];
  if (typeFilter) binds.push(...typeFilter);
  binds.push(limit);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<FtsRow>();
  const rows: FtsRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);

  return rows.map((row) => ({
    resourceType: normalizeResourceType(row.resource_type),
    resourceId: row.resource_id,
    workspaceId: row.workspace_id,
    pageId: row.page_id,
    folderId: row.folder_id,
    title: row.title,
    path: row.path,
    snippet: row.snippet ?? "",
    url: row.url,
    rank: row.rank,
  }));
}

// UPSERT into search_recent_resources. Bumps last_opened_at to "now"
// and increments open_count. The composite PK on
// (user_id, resource_type, resource_id) lets ON CONFLICT do the
// right thing without an explicit existence check.
export async function recordRecentOpen(
  ctx: ServiceContext,
  input: {
    userId: string;
    workspaceId: string;
    resourceType: SearchResourceType;
    resourceId: string;
  },
): Promise<void> {
  const db = requireDb(ctx);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO search_recent_resources (
         user_id, workspace_id, resource_type, resource_id,
         last_opened_at, open_count
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1)
       ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         last_opened_at = excluded.last_opened_at,
         open_count = search_recent_resources.open_count + 1`,
    )
    .bind(
      input.userId,
      input.workspaceId,
      input.resourceType,
      input.resourceId,
      now,
    )
    .run();
}

type RecentRow = {
  resource_type: string;
  resource_id: string;
  last_opened_at: string;
};

export async function listRecent(
  ctx: ServiceContext,
  input: { userId: string; workspaceId: string; limit?: number },
): Promise<RecentResourceRecord[]> {
  const db = requireDb(ctx);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const result = await db
    .prepare(
      `SELECT resource_type, resource_id, last_opened_at
         FROM search_recent_resources
        WHERE user_id = ?1 AND workspace_id = ?2
        ORDER BY last_opened_at DESC
        LIMIT ?3`,
    )
    .bind(input.userId, input.workspaceId, limit)
    .all<RecentRow>();
  const rows: RecentRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);

  return rows.map((row) => ({
    resourceType: normalizeResourceType(row.resource_type),
    resourceId: row.resource_id,
    lastOpenedAt: row.last_opened_at,
  }));
}

// Re-derive search_documents from the base tables for one workspace.
// Intended for a Day-12 cron that backfills/repairs the index.
//
// We INSERT OR REPLACE every row; the triggers keep the FTS mirror in
// sync. Body text is not re-extracted from R2 here — that's a more
// expensive job. For now we index title + path + tags, which is what
// the FTS5 MATCH needs to find a resource by name or path segment.
// A later pass can layer in headings_text/body_text re-extraction
// without changing the service contract.

type PageBaseRow = {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  title: string;
  slug_id: string;
  source_type: string;
  object_key_current: string;
  updated_at: string;
};

type FolderBaseRow = {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  slug_id: string;
  updated_at: string;
};

type CommentThreadBaseRow = {
  id: string;
  page_id: string;
  workspace_id: string;
  selected_text: string;
  updated_at: string;
};

export async function reconcileWorkspace(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<ReconcileCounts> {
  const db = requireDb(ctx);

  // Pages — skip soft-deleted rows. Reconciliation re-derives the FTS
  // entry from the canonical source blob (via object_key_current) so
  // any rows that drifted from background-task drops or partial
  // earlier indexing pick up the full body text on the next nightly
  // run.
  const pagesResult = await db
    .prepare(
      `SELECT id, workspace_id, folder_id, title, slug_id, source_type,
              object_key_current, updated_at
         FROM pages
        WHERE workspace_id = ?1 AND deleted_at IS NULL`,
    )
    .bind(input.workspaceId)
    .all<PageBaseRow>();
  const pageRows: PageBaseRow[] = Array.isArray(pagesResult)
    ? pagesResult
    : (pagesResult.results ?? []);

  for (const row of pageRows) {
    let bodyText = "";
    if (ctx.objectStore && row.object_key_current) {
      try {
        const obj = await ctx.objectStore.get(row.object_key_current);
        if (obj?.body) {
          bodyText =
            row.source_type === "html" ? htmlToPlainText(obj.body) : obj.body;
        }
      } catch {
        // Missing blob — index with empty body; next save will heal.
      }
    }
    await index(ctx, {
      resourceType: "page",
      resourceId: row.id,
      workspaceId: row.workspace_id,
      pageId: row.id,
      folderId: row.folder_id,
      title: row.title,
      path: row.title,
      headingsText: "",
      frontmatterText: "",
      bodyText,
      commentText: "",
      tags: "",
      url: `/p/${row.slug_id}`,
      updatedAt: row.updated_at,
    });
  }

  const foldersResult = await db
    .prepare(
      `SELECT id, workspace_id, name, path, slug_id, updated_at
         FROM folders
        WHERE workspace_id = ?1`,
    )
    .bind(input.workspaceId)
    .all<FolderBaseRow>();
  const folderRows: FolderBaseRow[] = Array.isArray(foldersResult)
    ? foldersResult
    : (foldersResult.results ?? []);

  for (const row of folderRows) {
    await index(ctx, {
      resourceType: "folder",
      resourceId: row.id,
      workspaceId: row.workspace_id,
      pageId: null,
      folderId: row.id,
      title: row.name,
      path: row.path,
      headingsText: "",
      frontmatterText: "",
      bodyText: "",
      commentText: "",
      tags: "",
      url: `/f/${row.slug_id}`,
      updatedAt: row.updated_at,
    });
  }

  const commentsResult = await db
    .prepare(
      `SELECT id, page_id, workspace_id, selected_text, updated_at
         FROM comment_threads
        WHERE workspace_id = ?1`,
    )
    .bind(input.workspaceId)
    .all<CommentThreadBaseRow>();
  const commentRows: CommentThreadBaseRow[] = Array.isArray(commentsResult)
    ? commentsResult
    : (commentsResult.results ?? []);

  for (const row of commentRows) {
    await index(ctx, {
      resourceType: "comment_thread",
      resourceId: row.id,
      workspaceId: row.workspace_id,
      pageId: row.page_id,
      folderId: null,
      title: row.selected_text.slice(0, 80),
      path: "",
      headingsText: "",
      frontmatterText: "",
      bodyText: "",
      commentText: row.selected_text,
      tags: "",
      url: `/p/${row.page_id}#thread-${row.id}`,
      updatedAt: row.updated_at,
    });
  }

  return {
    pages: pageRows.length,
    folders: folderRows.length,
    comments: commentRows.length,
  };
}
