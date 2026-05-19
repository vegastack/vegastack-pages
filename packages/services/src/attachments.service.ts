// Attachments service — direct-D1 reads/writes against the attachments
// table, with object-store side effects for the raw blob.
//
// Plan 011 §5. Replaces the in-memory AttachmentService in
// packages/core/src/attachments.ts with plain async functions over
// ServiceContext.
//
// Object key convention: attachments/{workspaceId}/{sha256(body)}.{ext}
// where ext is derived from the contentType (preferred) or falls back to
// the filename. Content-addressed keys mean re-uploads of the same bytes
// reuse the same R2 object; the D1 row still gets a fresh id so the
// page-attachment relationship is unique per upload.
//
// Authorization contract: routes/MCP MUST verify the actor has write
// access to the page BEFORE calling upload(), and read access before
// get/listForPage/getByObjectKey. This service only validates that a
// D1 + ObjectStore are present and that the input is well-formed.

import { createId, idPrefixes } from "@vegastack/pages-core";
import {
  requireDb,
  requireObjectStore,
  type ServiceContext,
} from "./context.ts";
import { clampLimit, decodeCursor, encodeCursor } from "./cursor.ts";
import type { PaginatedResult } from "./cursor.ts";

export type AttachmentRecord = {
  id: string;
  workspaceId: string;
  pageId: string;
  filename: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  imageWidth: number | null;
  imageHeight: number | null;
  createdBy: string | null;
  createdAt: string;
};

export type UploadAttachmentInput = {
  workspaceId: string;
  pageId: string;
  filename: string;
  contentType: string;
  // The object store now accepts text and binary bodies. Text uploads
  // remain string; image / PDF / other binary uploads pass through an
  // ArrayBuffer or Uint8Array to preserve byte fidelity. byteSize must
  // be the count of RAW bytes (not the base64-encoded length) so the
  // schema's CHECK (byte_size >= 0) and any per-workspace storage
  // accounting reflect real disk usage.
  body: string | ArrayBuffer | Uint8Array;
  byteSize: number;
  imageWidth?: number | null;
  imageHeight?: number | null;
};

type AttachmentRow = {
  id: string;
  workspace_id: string;
  page_id: string;
  filename: string;
  object_key: string;
  content_type: string;
  byte_size: number;
  image_width: number | null;
  image_height: number | null;
  created_by: string | null;
  created_at: string;
};

// Common content-type → extension. Anything not in the table falls back
// to the filename's extension; if that's missing too we use "bin".
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "application/json": "json",
};

function deriveExtension(contentType: string, filename: string): string {
  const lower = contentType.toLowerCase().split(";")[0]!.trim();
  const mapped = CONTENT_TYPE_EXT[lower];
  if (mapped) return mapped;
  const dot = filename.lastIndexOf(".");
  if (dot >= 0 && dot < filename.length - 1) {
    return (
      filename
        .slice(dot + 1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 8) || "bin"
    );
  }
  return "bin";
}

async function sha256Hex(
  body: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  // Hash exact bytes — text and binary alike. UTF-8 encode strings so
  // the same input always produces the same hash regardless of how it
  // was wrapped at the call site.
  const bytes: BufferSource =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? (body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer)
        : (body as ArrayBuffer);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function rowToRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    pageId: row.page_id,
    filename: row.filename,
    objectKey: row.object_key,
    contentType: row.content_type,
    byteSize: row.byte_size,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function upload(
  ctx: ServiceContext,
  input: UploadAttachmentInput,
): Promise<AttachmentRecord> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);

  const ext = deriveExtension(input.contentType, input.filename);
  const hash = await sha256Hex(input.body);
  const objectKey = `attachments/${input.workspaceId}/${hash}.${ext}`;

  // Write the blob first so a D1 row never points at a missing object.
  // If the same bytes were uploaded before, put() is an idempotent
  // overwrite — safe.
  await objectStore.put(objectKey, input.body, {
    contentType: input.contentType,
  });

  const id = createId(idPrefixes.attachment);
  const createdAt = new Date().toISOString();
  const createdBy = ctx.actor.userId || null;
  const imageWidth = input.imageWidth ?? null;
  const imageHeight = input.imageHeight ?? null;

  await db
    .prepare(
      `INSERT INTO attachments
         (id, workspace_id, page_id, filename, object_key, content_type,
          byte_size, image_width, image_height, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      id,
      input.workspaceId,
      input.pageId,
      input.filename,
      objectKey,
      input.contentType,
      input.byteSize,
      imageWidth,
      imageHeight,
      createdBy,
      createdAt,
    )
    .run();

  return {
    id,
    workspaceId: input.workspaceId,
    pageId: input.pageId,
    filename: input.filename,
    objectKey,
    contentType: input.contentType,
    byteSize: input.byteSize,
    imageWidth,
    imageHeight,
    createdBy,
    createdAt,
  };
}

export async function get(
  ctx: ServiceContext,
  attachmentId: string,
): Promise<AttachmentRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT id, workspace_id, page_id, filename, object_key, content_type,
              byte_size, image_width, image_height, created_by, created_at
         FROM attachments
        WHERE id = ?1`,
    )
    .bind(attachmentId)
    .first<AttachmentRow>();
  return row ? rowToRecord(row) : null;
}

export async function getByObjectKey(
  ctx: ServiceContext,
  objectKey: string,
): Promise<AttachmentRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT id, workspace_id, page_id, filename, object_key, content_type,
              byte_size, image_width, image_height, created_by, created_at
         FROM attachments
        WHERE object_key = ?1`,
    )
    .bind(objectKey)
    .first<AttachmentRow>();
  return row ? rowToRecord(row) : null;
}

const ATTACHMENT_LIST_HARD_CAP = 1000;

export async function listForPage(
  ctx: ServiceContext,
  input: { pageId: string; limit?: number },
): Promise<AttachmentRecord[]> {
  const db = requireDb(ctx);
  const limit = Math.min(
    ATTACHMENT_LIST_HARD_CAP,
    Math.max(1, Math.floor(input.limit ?? ATTACHMENT_LIST_HARD_CAP)),
  );
  // Index: attachments_page_idx (page_id). Sort newest-first so callers
  // can render most-recent uploads at the top. Hard cap so a page
  // pathologically loaded up with attachments can't blow the Worker
  // memory budget.
  const result = await db
    .prepare(
      `SELECT id, workspace_id, page_id, filename, object_key, content_type,
              byte_size, image_width, image_height, created_by, created_at
         FROM attachments
        WHERE page_id = ?1
        ORDER BY created_at ASC, id ASC
        LIMIT ?2`,
    )
    .bind(input.pageId, limit)
    .all<AttachmentRow>();
  const rows: AttachmentRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);
  return rows.map(rowToRecord);
}

// Cursor-paginated alternative. Attachments sort by created_at ASC so
// the page's history reads chronologically. Cursor's `updatedAt` slot
// carries the row's created_at — the field name is the generic "sort
// timestamp" carrier from `cursor.ts`, not an attachments-table column.
export async function listForPagePaginated(
  ctx: ServiceContext,
  input: { pageId: string; limit?: number; cursor?: string },
): Promise<PaginatedResult<AttachmentRecord>> {
  const db = requireDb(ctx);
  const limit = clampLimit(input.limit, {
    default: 100,
    hardCap: ATTACHMENT_LIST_HARD_CAP,
  });
  const cursor = decodeCursor(input.cursor);
  const fetchLimit = limit + 1;
  const result = cursor
    ? // ASC ordering: next page picks up rows AFTER the cursor.
      await db
        .prepare(
          `SELECT id, workspace_id, page_id, filename, object_key, content_type,
                  byte_size, image_width, image_height, created_by, created_at
             FROM attachments
            WHERE page_id = ?1
              AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
            ORDER BY created_at ASC, id ASC
            LIMIT ?4`,
        )
        .bind(input.pageId, cursor.updatedAt, cursor.id, fetchLimit)
        .all<AttachmentRow>()
    : await db
        .prepare(
          `SELECT id, workspace_id, page_id, filename, object_key, content_type,
                  byte_size, image_width, image_height, created_by, created_at
             FROM attachments
            WHERE page_id = ?1
            ORDER BY created_at ASC, id ASC
            LIMIT ?2`,
        )
        .bind(input.pageId, fetchLimit)
        .all<AttachmentRow>();
  const rows: AttachmentRow[] = Array.isArray(result)
    ? result
    : (result.results ?? []);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(rowToRecord),
    nextCursor:
      hasMore && last
        ? encodeCursor({ updatedAt: last.created_at, id: last.id })
        : null,
  };
}

export async function remove(
  ctx: ServiceContext,
  attachmentId: string,
): Promise<void> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);

  // Read first so we know the object key even if the row is gone after
  // delete. If the row doesn't exist this is a no-op (idempotent).
  const existing = await get(ctx, attachmentId);
  if (!existing) return;

  await db
    .prepare("DELETE FROM attachments WHERE id = ?1")
    .bind(attachmentId)
    .run();

  // Object-store delete last: if it fails we'll have orphaned bytes
  // (cheap to GC) rather than a row pointing at nothing.
  await objectStore.delete(existing.objectKey);
}
