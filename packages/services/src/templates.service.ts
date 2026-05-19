// Templates service — direct-D1 reads/writes against the
// workspace_templates and workspace_template_versions tables, with
// object-store side effects for the template source body.
//
// Plan 011 §5. Replaces the in-memory TemplateService class in
// packages/core/src/template-service.ts with plain async functions over
// ServiceContext.
//
// Object key convention: templates/{workspaceId}/{templateId}/source-{hash}.{ext}
// where ext is "md" for markdown and "mdx" for mdx. Content-addressed
// keys mean repeat saves of identical bytes reuse the same R2 object;
// each save still inserts a fresh version row so callers can browse
// history.
//
// Authorization contract: routes/MCP MUST verify the actor has the
// required workspace scope BEFORE calling these mutations. This service
// only validates that a D1 + ObjectStore are present and that the
// input is well-formed.
//
// Pure rendering primitives (property substitution, builder doc
// helpers) live in packages/core/src/template-builder.ts and
// template-service.ts and are re-used here verbatim. This file owns
// only the persistence layer plus the thin render() facade.

import {
  AppError,
  createId,
  idPrefixes,
  renderTemplateBody,
  type TemplateProperty,
} from "@vegastack/pages-core";
import {
  d1AllRows,
  type D1Database,
  type D1PreparedStatement,
} from "@vegastack/pages-db";
import {
  requireDb,
  requireObjectStore,
  type ServiceContext,
} from "./context.ts";

// db.batch is optional in the minimal D1 type (the node-sqlite test
// adapter implements it, but some lighter adapters might not). Fall
// back to sequential .run() so the same code path works everywhere.
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

export type TemplateSourceType = "markdown" | "mdx";

export type { TemplateProperty } from "@vegastack/pages-core";

export type TemplateRecord = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  sourceType: TemplateSourceType;
  objectKeyCurrent: string;
  contentHash: string;
  versionId: string;
  properties: TemplateProperty[];
  isBuiltin: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TemplateVersionRecord = {
  id: string;
  templateId: string;
  workspaceId: string;
  objectKey: string;
  sourceHash: string;
  sourceType: TemplateSourceType;
  properties: TemplateProperty[];
  label: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type TemplateWithSource = TemplateRecord & { source: string };

export type CreateTemplateInput = {
  workspaceId: string;
  slug: string;
  name: string;
  description?: string;
  category?: string;
  sourceType?: TemplateSourceType;
  source: string;
  properties?: TemplateProperty[];
  isBuiltin?: boolean;
};

export type UpdateTemplateInput = {
  name?: string;
  description?: string;
  category?: string;
  source?: string;
  sourceType?: TemplateSourceType;
  properties?: TemplateProperty[];
  label?: string;
};

export type RenderInput = {
  templateId: string;
  values: Record<string, unknown>;
};

export type RenderResult = {
  title: string;
  body: string;
  sourceType: TemplateSourceType;
};

type TemplateRow = {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  source_type: string;
  object_key_current: string;
  content_hash: string;
  version_id: string;
  properties_json: string;
  is_builtin: number;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type TemplateVersionRow = {
  id: string;
  template_id: string;
  workspace_id: string;
  object_key: string;
  source_hash: string;
  source_type: string;
  properties_json: string;
  label: string | null;
  created_by: string | null;
  created_at: string;
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TEMPLATE_COLUMNS =
  "id, workspace_id, slug, name, description, category, source_type, " +
  "object_key_current, content_hash, version_id, properties_json, " +
  "is_builtin, created_by, deleted_at, created_at, updated_at";

const VERSION_COLUMNS =
  "id, template_id, workspace_id, object_key, source_hash, source_type, " +
  "properties_json, label, created_by, created_at";

function normalizeSourceType(value: string): TemplateSourceType {
  return value === "mdx" ? "mdx" : "markdown";
}

function extensionFor(sourceType: TemplateSourceType): string {
  return sourceType === "mdx" ? "mdx" : "md";
}

function contentTypeFor(sourceType: TemplateSourceType): string {
  return sourceType === "mdx"
    ? "text/markdown; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

function parseProperties(raw: string): TemplateProperty[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TemplateProperty[]) : [];
  } catch {
    return [];
  }
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

function rowToTemplate(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    sourceType: normalizeSourceType(row.source_type),
    objectKeyCurrent: row.object_key_current,
    contentHash: row.content_hash,
    versionId: row.version_id,
    properties: parseProperties(row.properties_json),
    isBuiltin: row.is_builtin === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: TemplateVersionRow): TemplateVersionRecord {
  return {
    id: row.id,
    templateId: row.template_id,
    workspaceId: row.workspace_id,
    objectKey: row.object_key,
    sourceHash: row.source_hash,
    sourceType: normalizeSourceType(row.source_type),
    properties: parseProperties(row.properties_json),
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function buildObjectKey(
  workspaceId: string,
  templateId: string,
  hash: string,
  sourceType: TemplateSourceType,
): string {
  return `templates/${workspaceId}/${templateId}/source-${hash}.${extensionFor(sourceType)}`;
}

function assertSlug(slug: string): void {
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Invalid template slug: "${slug}".`,
      400,
      { slug },
    );
  }
}

function assertSource(source: string): void {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Template source must be a non-empty string.",
      400,
    );
  }
}

export async function create(
  ctx: ServiceContext,
  input: CreateTemplateInput,
): Promise<TemplateRecord> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);

  const name = (input.name ?? "").trim();
  if (!name) {
    throw new AppError("VALIDATION_ERROR", "Template name is required.", 400);
  }
  assertSlug(input.slug);
  assertSource(input.source);

  const sourceType: TemplateSourceType = input.sourceType ?? "markdown";
  const category = (input.category?.trim() || "general").toLowerCase();
  const description = input.description?.trim() ?? "";
  const properties = input.properties ?? [];
  const isBuiltin = input.isBuiltin === true;
  const createdBy = ctx.actor.userId || null;

  const templateId = createId(idPrefixes.template);
  const versionId = createId(idPrefixes.version);
  const contentHash = await sha256Hex(input.source);
  const objectKey = buildObjectKey(
    input.workspaceId,
    templateId,
    contentHash,
    sourceType,
  );
  const now = new Date().toISOString();

  // Persist the blob first so a D1 row never points at a missing
  // object. Same-bytes put() is an idempotent overwrite.
  await objectStore.put(objectKey, input.source, {
    contentType: contentTypeFor(sourceType),
  });

  const propertiesJson = JSON.stringify(properties);

  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO workspace_templates
           (id, workspace_id, slug, name, description, category, source_type,
            object_key_current, content_hash, version_id, properties_json,
            is_builtin, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
      )
      .bind(
        templateId,
        input.workspaceId,
        input.slug,
        name,
        description,
        category,
        sourceType,
        objectKey,
        contentHash,
        versionId,
        propertiesJson,
        isBuiltin ? 1 : 0,
        createdBy,
        now,
      ),
    db
      .prepare(
        `INSERT INTO workspace_template_versions
           (id, template_id, workspace_id, object_key, source_hash, source_type,
            properties_json, label, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        versionId,
        templateId,
        input.workspaceId,
        objectKey,
        contentHash,
        sourceType,
        propertiesJson,
        "Initial version",
        createdBy,
        now,
      ),
  ]);

  return {
    id: templateId,
    workspaceId: input.workspaceId,
    slug: input.slug,
    name,
    description,
    category,
    sourceType,
    objectKeyCurrent: objectKey,
    contentHash,
    versionId,
    properties,
    isBuiltin,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

async function loadTemplateRow(
  ctx: ServiceContext,
  templateId: string,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): Promise<TemplateRow | null> {
  const db = requireDb(ctx);
  const query = includeDeleted
    ? `SELECT ${TEMPLATE_COLUMNS} FROM workspace_templates WHERE id = ?1`
    : `SELECT ${TEMPLATE_COLUMNS} FROM workspace_templates
        WHERE id = ?1 AND deleted_at IS NULL`;
  const row = await db.prepare(query).bind(templateId).first<TemplateRow>();
  return row ?? null;
}

export async function update(
  ctx: ServiceContext,
  templateId: string,
  input: UpdateTemplateInput,
): Promise<TemplateRecord> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);

  const existing = await loadTemplateRow(ctx, templateId);
  if (!existing) {
    throw new AppError("TEMPLATE_NOT_FOUND", "Template was not found.", 404);
  }

  const sourceType: TemplateSourceType = input.sourceType
    ? input.sourceType
    : normalizeSourceType(existing.source_type);
  const name = input.name?.trim() || existing.name;
  if (!name) {
    throw new AppError("VALIDATION_ERROR", "Template name is required.", 400);
  }
  const description =
    input.description === undefined
      ? existing.description
      : input.description.trim();
  const category =
    input.category === undefined
      ? existing.category
      : (input.category.trim() || "general").toLowerCase();
  const properties =
    input.properties ?? parseProperties(existing.properties_json);
  const createdBy = ctx.actor.userId || null;
  const now = new Date().toISOString();

  const sourceProvided = input.source !== undefined;
  if (sourceProvided) assertSource(input.source!);

  let objectKey = existing.object_key_current;
  let contentHash = existing.content_hash;
  let versionId = existing.version_id;

  if (sourceProvided) {
    contentHash = await sha256Hex(input.source!);
    versionId = createId(idPrefixes.version);
    objectKey = buildObjectKey(
      existing.workspace_id,
      existing.id,
      contentHash,
      sourceType,
    );
    // Write the blob before mutating D1 so the row never points at a
    // missing object on partial failure.
    await objectStore.put(objectKey, input.source!, {
      contentType: contentTypeFor(sourceType),
    });

    const propertiesJson = JSON.stringify(properties);
    await runBatch(db, [
      db
        .prepare(
          `UPDATE workspace_templates
              SET name = ?1, description = ?2, category = ?3,
                  source_type = ?4, object_key_current = ?5, content_hash = ?6,
                  version_id = ?7, properties_json = ?8, updated_at = ?9
            WHERE id = ?10`,
        )
        .bind(
          name,
          description,
          category,
          sourceType,
          objectKey,
          contentHash,
          versionId,
          propertiesJson,
          now,
          templateId,
        ),
      db
        .prepare(
          `INSERT INTO workspace_template_versions
             (id, template_id, workspace_id, object_key, source_hash, source_type,
              properties_json, label, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          versionId,
          templateId,
          existing.workspace_id,
          objectKey,
          contentHash,
          sourceType,
          propertiesJson,
          input.label ?? null,
          createdBy,
          now,
        ),
    ]);
  } else {
    // Metadata-only update — objectKeyCurrent / contentHash / versionId
    // stay frozen.
    const propertiesJson = JSON.stringify(properties);
    await db
      .prepare(
        `UPDATE workspace_templates
            SET name = ?1, description = ?2, category = ?3,
                source_type = ?4, properties_json = ?5, updated_at = ?6
          WHERE id = ?7`,
      )
      .bind(
        name,
        description,
        category,
        sourceType,
        propertiesJson,
        now,
        templateId,
      )
      .run();
  }

  return {
    id: existing.id,
    workspaceId: existing.workspace_id,
    slug: existing.slug,
    name,
    description,
    category,
    sourceType,
    objectKeyCurrent: objectKey,
    contentHash,
    versionId,
    properties,
    isBuiltin: existing.is_builtin === 1,
    createdBy: existing.created_by,
    createdAt: existing.created_at,
    updatedAt: now,
  };
}

export async function get(
  ctx: ServiceContext,
  templateId: string,
): Promise<TemplateRecord | null> {
  const row = await loadTemplateRow(ctx, templateId);
  return row ? rowToTemplate(row) : null;
}

export async function getBySlug(
  ctx: ServiceContext,
  input: { workspaceId: string; slug: string },
): Promise<TemplateRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT ${TEMPLATE_COLUMNS}
         FROM workspace_templates
        WHERE workspace_id = ?1 AND slug = ?2 AND deleted_at IS NULL`,
    )
    .bind(input.workspaceId, input.slug)
    .first<TemplateRow>();
  return row ? rowToTemplate(row) : null;
}

export async function getWithSource(
  ctx: ServiceContext,
  templateId: string,
): Promise<TemplateWithSource | null> {
  const template = await get(ctx, templateId);
  if (!template) return null;
  const objectStore = requireObjectStore(ctx);
  const stored = await objectStore.get(template.objectKeyCurrent);
  if (!stored) {
    throw new AppError(
      "TEMPLATE_NOT_FOUND",
      "Template source object was not found.",
      404,
    );
  }
  return { ...template, source: stored.body };
}

export async function listForWorkspace(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<TemplateRecord[]> {
  const db = requireDb(ctx);
  // Sorted by category, then name, matching the workspace_templates
  // composite index.
  const result = await db
    .prepare(
      `SELECT ${TEMPLATE_COLUMNS}
         FROM workspace_templates
        WHERE workspace_id = ?1 AND deleted_at IS NULL
        ORDER BY category ASC, name ASC, id ASC`,
    )
    .bind(input.workspaceId)
    .all<TemplateRow>();
  return d1AllRows(result).map(rowToTemplate);
}

export async function listVersions(
  ctx: ServiceContext,
  input: { templateId: string },
): Promise<TemplateVersionRecord[]> {
  const db = requireDb(ctx);
  // Newest-first so history viewers can show the latest at the top
  // without re-sorting. Tie-break on the implicit sqlite rowid which
  // strictly increases per INSERT, so two versions written in the same
  // millisecond preserve their actual insertion order. (Random `id`
  // breaks this in fast back-to-back updates and made the test flaky.)
  const result = await db
    .prepare(
      `SELECT ${VERSION_COLUMNS}
         FROM workspace_template_versions
        WHERE template_id = ?1
        ORDER BY created_at DESC, rowid DESC`,
    )
    .bind(input.templateId)
    .all<TemplateVersionRow>();
  return d1AllRows(result).map(rowToVersion);
}

export async function remove(
  ctx: ServiceContext,
  templateId: string,
): Promise<void> {
  const db = requireDb(ctx);
  // Soft delete: keep the row + every version + the R2 blob so callers
  // can still resolve historical references. A hard purge is a
  // separate maintenance job.
  const existing = await loadTemplateRow(ctx, templateId);
  if (!existing) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE workspace_templates SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
    )
    .bind(now, templateId)
    .run();
}

export async function render(
  ctx: ServiceContext,
  input: RenderInput,
): Promise<RenderResult> {
  const withSource = await getWithSource(ctx, input.templateId);
  if (!withSource) {
    throw new AppError("TEMPLATE_NOT_FOUND", "Template was not found.", 404);
  }
  const rawTitle = input.values["title"];
  const title =
    typeof rawTitle === "string" && rawTitle.trim().length > 0
      ? rawTitle.trim()
      : withSource.name;
  // Delegate the actual {{ title }}/{{ date }} substitution to the
  // pure renderer in packages/core so this service stays a thin
  // persistence + orchestration layer.
  const body = renderTemplateBody(withSource.source, title, new Date());
  return {
    title,
    body,
    sourceType: withSource.sourceType,
  };
}
