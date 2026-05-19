// Publications service — direct-D1 reads/writes against the publications table.
//
// Plan 011 §5. Replaces packages/core/src/publications.ts (class-based,
// in-memory `PublicationService` using argon2id) with plain async
// functions over ServiceContext.
//
// Authorization contract: routes/MCP adapters are responsible for
// verifying that the actor has the required scope on the resource
// (page or folder) BEFORE invoking a mutation here. This service only
// validates that the publication exists and applies the requested
// patch; it does not check workspace membership or per-resource
// permissions.
//
// Password hashing: PBKDF2-HMAC-SHA-256 with 100,000 iterations and a
// per-record 16-byte random salt, stored as
// `"pbkdf2$100000$<salt-hex>$<derived-hex>"`. argon2id would be
// preferred but isn't available natively in Workers without a wasm
// dependency. PBKDF2 via Web Crypto gives ~30-40ms per verify on
// Workers which is acceptable for a publication-unlock action and is
// orders of magnitude harder to brute-force than the previous SHA-256
// scheme (~3 ns / guess on a single GPU SM).
//
// Legacy `sha256:<salt>:<hash>` rows are still accepted by
// verifyPasswordAgainstHash so existing publications keep working;
// upsertPublication transparently upgrades to PBKDF2 on the next
// `password` field write.

import { AppError, createId, idPrefixes } from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

export type PublicationPermission = "view" | "comment" | "edit";
export type PublicationResourceType = "page" | "folder";

export type PublicationRecord = {
  id: string;
  workspaceId: string;
  resourceType: PublicationResourceType;
  resourceId: string;
  permission: PublicationPermission;
  expiresAt: string | null;
  passwordHash: string | null;
  indexingEnabled: boolean;
  revokedAt: string | null;
  latestArtifactKey: string | null;
  latestContentHash: string | null;
  latestRenderedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FindForResourceInput = {
  workspaceId: string;
  resourceType: PublicationResourceType;
  resourceId: string;
};

export type UpsertPublicationInput = {
  workspaceId: string;
  resourceType: PublicationResourceType;
  resourceId: string;
  permission: PublicationPermission;
  expiresAt?: string | null;
  // Plaintext password. `undefined` leaves the existing hash unchanged;
  // `null` clears it; a non-empty string is hashed and stored.
  password?: string | null;
  indexingEnabled?: boolean;
};

export type UpdatePublicationInput = {
  permission?: PublicationPermission;
  expiresAt?: string | null;
  password?: string | null;
  indexingEnabled?: boolean;
};

export type VerifyPasswordInput = {
  publicationId: string;
  password: string;
};

export type SetLatestArtifactInput = {
  publicationId: string;
  artifactKey: string;
  contentHash: string;
  renderedAt: string;
};

type PublicationRow = {
  id: string;
  workspace_id: string;
  resource_type: PublicationResourceType;
  resource_id: string;
  permission: PublicationPermission;
  expires_at: string | null;
  password_hash: string | null;
  indexing_enabled: number;
  revoked_at: string | null;
  latest_artifact_key: string | null;
  latest_content_hash: string | null;
  latest_rendered_at: string | null;
  created_at: string;
  updated_at: string;
};

// Current scheme. Existing rows on the legacy "sha256" scheme are
// still verifiable (see verifyPasswordAgainstHash) and are upgraded on
// the next password set.
const PASSWORD_SCHEME = "pbkdf2";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DERIVED_BYTES = 32;
const SALT_BYTES = 16;

function rowToRecord(row: PublicationRow): PublicationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    permission: row.permission,
    expiresAt: row.expires_at,
    passwordHash: row.password_hash,
    indexingEnabled: row.indexing_enabled === 1,
    revokedAt: row.revoked_at,
    latestArtifactKey: row.latest_artifact_key,
    latestContentHash: row.latest_content_hash,
    latestRenderedAt: row.latest_rendered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    out += bytes[index]!.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToHex(new Uint8Array(digest));
}

async function pbkdf2Derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  derivedBytes: number,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const saltBuffer = salt.buffer.slice(
    salt.byteOffset,
    salt.byteOffset + salt.byteLength,
  ) as ArrayBuffer;
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBuffer,
      iterations,
    },
    keyMaterial,
    derivedBytes * 8,
  );
  return bytesToHex(new Uint8Array(derived));
}

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const saltHex = bytesToHex(salt);
  const derivedHex = await pbkdf2Derive(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_DERIVED_BYTES,
  );
  // `$` delimiter (PHC-style) so the iteration count is unambiguous
  // when we eventually rotate it. Salt is stored as hex for
  // backward-compat with the existing `bytesToHex` helper.
  return `${PASSWORD_SCHEME}$${PBKDF2_ITERATIONS}$${saltHex}$${derivedHex}`;
}

function constantTimeEqualHex(left: string, right: string): boolean {
  // Both values are lowercase hex of equal length when produced by our
  // hasher, but defend against malformed input.
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function verifyPasswordAgainstHash(
  storedHash: string,
  password: string,
): Promise<boolean> {
  // Current scheme: `pbkdf2$<iters>$<saltHex>$<derivedHex>`.
  if (storedHash.startsWith("pbkdf2$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 4) return false;
    const [, itersStr, saltHex, expectedHex] = parts as [
      string,
      string,
      string,
      string,
    ];
    const iters = Number.parseInt(itersStr ?? "", 10);
    if (!Number.isFinite(iters) || iters < 1) return false;
    if (!saltHex || !expectedHex) return false;
    const actualHex = await pbkdf2Derive(
      password,
      hexToBytes(saltHex),
      iters,
      Math.floor(expectedHex.length / 2),
    );
    return constantTimeEqualHex(actualHex, expectedHex);
  }
  // Legacy scheme: `sha256:<saltHex>:<hashHex>`. Kept for back-compat
  // with rows written before the PBKDF2 upgrade; on a successful
  // legacy verify the caller can upgrade the row by calling upsert
  // with the same password.
  if (storedHash.startsWith("sha256:")) {
    const parts = storedHash.split(":");
    if (parts.length !== 3) return false;
    const [, saltHex, expectedHashHex] = parts as [string, string, string];
    if (!saltHex || !expectedHashHex) return false;
    const actualHashHex = await sha256Hex(`${saltHex}:${password}`);
    return constantTimeEqualHex(actualHashHex, expectedHashHex);
  }
  return false;
}

const SELECT_COLUMNS = `id, workspace_id, resource_type, resource_id,
            permission, expires_at, password_hash, indexing_enabled,
            revoked_at, latest_artifact_key, latest_content_hash,
            latest_rendered_at, created_at, updated_at`;

export async function findForResource(
  ctx: ServiceContext,
  input: FindForResourceInput,
): Promise<PublicationRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM publications
        WHERE workspace_id = ?1 AND resource_type = ?2 AND resource_id = ?3`,
    )
    .bind(input.workspaceId, input.resourceType, input.resourceId)
    .first<PublicationRow>();
  return row ? rowToRecord(row) : null;
}

export async function get(
  ctx: ServiceContext,
  publicationId: string,
): Promise<PublicationRecord | null> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM publications
        WHERE id = ?1`,
    )
    .bind(publicationId)
    .first<PublicationRow>();
  return row ? rowToRecord(row) : null;
}

export async function upsert(
  ctx: ServiceContext,
  input: UpsertPublicationInput,
): Promise<PublicationRecord> {
  const db = requireDb(ctx);

  // Look up any existing row for this (workspace, type, resourceId)
  // tuple so we can preserve the id, createdAt, password_hash (when
  // unchanged), and any latest_* artifact pointer.
  const existing = await findForResource(ctx, {
    workspaceId: input.workspaceId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  });

  const now = new Date().toISOString();
  const id = existing?.id ?? createId(idPrefixes.publication);
  const createdAt = existing?.createdAt ?? now;

  const expiresAt =
    input.expiresAt === undefined
      ? (existing?.expiresAt ?? null)
      : input.expiresAt;

  let passwordHash: string | null;
  if (input.password === undefined) {
    passwordHash = existing?.passwordHash ?? null;
  } else if (input.password === null || input.password === "") {
    passwordHash = null;
  } else {
    passwordHash = await hashPassword(input.password);
  }

  const indexingEnabled =
    input.indexingEnabled ?? existing?.indexingEnabled ?? false;

  await db
    .prepare(
      `INSERT INTO publications
         (id, workspace_id, resource_type, resource_id, permission,
          expires_at, password_hash, indexing_enabled, revoked_at,
          latest_artifact_key, latest_content_hash, latest_rendered_at,
          created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(workspace_id, resource_type, resource_id) DO UPDATE SET
         permission = excluded.permission,
         expires_at = excluded.expires_at,
         password_hash = excluded.password_hash,
         indexing_enabled = excluded.indexing_enabled,
         revoked_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      input.workspaceId,
      input.resourceType,
      input.resourceId,
      input.permission,
      expiresAt,
      passwordHash,
      indexingEnabled ? 1 : 0,
      existing?.latestArtifactKey ?? null,
      existing?.latestContentHash ?? null,
      existing?.latestRenderedAt ?? null,
      createdAt,
      now,
    )
    .run();

  const written = await get(ctx, id);
  if (!written) {
    // Should be unreachable — we just wrote it.
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  return written;
}

export async function update(
  ctx: ServiceContext,
  publicationId: string,
  patch: UpdatePublicationInput,
): Promise<PublicationRecord> {
  const existing = await get(ctx, publicationId);
  if (!existing) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }

  // Delegate to upsert so we get one canonical write path. We pass the
  // resource tuple from the existing row so the ON CONFLICT clause hits
  // the same row.
  return upsert(ctx, {
    workspaceId: existing.workspaceId,
    resourceType: existing.resourceType,
    resourceId: existing.resourceId,
    permission: patch.permission ?? existing.permission,
    expiresAt:
      patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
    // password: undefined means "leave unchanged" — pass through as
    // undefined so upsert's logic preserves the existing hash.
    password: patch.password,
    indexingEnabled: patch.indexingEnabled ?? existing.indexingEnabled,
  });
}

export async function revoke(
  ctx: ServiceContext,
  publicationId: string,
): Promise<PublicationRecord> {
  const db = requireDb(ctx);
  const existing = await get(ctx, publicationId);
  if (!existing) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  // Idempotent: if the row is already revoked, return it unchanged
  // rather than overwriting revoked_at with a newer timestamp.
  if (existing.revokedAt) {
    return existing;
  }
  const now = new Date().toISOString();
  // Mark revoked AND null out the artifact pointer in one UPDATE so a
  // future code path that consults `latest_artifact_key` without also
  // checking `revoked_at` cannot accidentally serve the artifact.
  await db
    .prepare(
      `UPDATE publications
          SET revoked_at = ?2,
              latest_artifact_key = NULL,
              latest_content_hash = NULL,
              latest_rendered_at = NULL,
              updated_at = ?2
        WHERE id = ?1`,
    )
    .bind(publicationId, now)
    .run();
  // Best-effort R2 cleanup of the previously-published artifact.
  const previousKey = existing.latestArtifactKey;
  if (previousKey && ctx.objectStore) {
    const store = ctx.objectStore;
    ctx.waitUntil(
      Promise.resolve().then(async () => {
        try {
          await store.delete(previousKey);
        } catch {
          // Ignore: revocation already persisted; orphan can be
          // collected by the R2 lifecycle rule.
        }
      }),
    );
  }
  // Best-effort edge-cache purge so the next anonymous read of the
  // public URL stops returning the now-revoked artifact. Same Cache
  // API pattern as publishFanOut; falls back silently when there is no
  // `caches.default` (Node-mode dev) or no `publicOrigin` to compose
  // the canonical URL from.
  if (ctx.publicOrigin) {
    const slug = await fetchResourceSlug(
      db,
      existing.resourceType,
      existing.resourceId,
    );
    const cacheGlobal = (
      globalThis as unknown as {
        caches?: { default?: { delete(req: Request): Promise<boolean> } };
      }
    ).caches;
    const edge = cacheGlobal?.default;
    if (slug && edge) {
      const path =
        existing.resourceType === "folder" ? `/f/${slug}` : `/p/${slug}`;
      ctx.waitUntil(
        edge
          .delete(new Request(`${ctx.publicOrigin}${path}`))
          .catch(() => undefined),
      );
    }
  }
  const after = await get(ctx, publicationId);
  if (!after) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  return after;
}

export async function verifyPassword(
  ctx: ServiceContext,
  input: VerifyPasswordInput,
): Promise<boolean> {
  const publication = await get(ctx, input.publicationId);
  if (!publication) return false;
  if (!publication.passwordHash) return false;
  return verifyPasswordAgainstHash(publication.passwordHash, input.password);
}

export async function setLatestArtifact(
  ctx: ServiceContext,
  input: SetLatestArtifactInput,
): Promise<void> {
  const db = requireDb(ctx);
  const existing = await get(ctx, input.publicationId);
  if (!existing) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE publications
          SET latest_artifact_key = ?2,
              latest_content_hash = ?3,
              latest_rendered_at = ?4,
              updated_at = ?5
        WHERE id = ?1`,
    )
    .bind(
      input.publicationId,
      input.artifactKey,
      input.contentHash,
      input.renderedAt,
      now,
    )
    .run();
}

// Find every publication that points at a given resource. Used by
// publishFanOut on page-source updates: a single page can be the
// resource for one page-level publication, but the page's parent
// folder may also be published — we fan out the rendered artifact to
// every applicable publication.
export async function findForResourceList(
  ctx: ServiceContext,
  inputs: Array<{
    workspaceId: string;
    resourceType: PublicationResourceType;
    resourceId: string;
  }>,
): Promise<PublicationRecord[]> {
  const out: PublicationRecord[] = [];
  for (const input of inputs) {
    const pub = await findForResource(ctx, input);
    if (pub && !pub.revokedAt) out.push(pub);
  }
  return out;
}

export type PublishFanOutInput = {
  publicationId: string;
  workspaceId: string;
  pageId: string;
  contentHash: string;
};

export type PublishFanOutResult = {
  publicationId: string;
  artifactKey: string;
  contentHash: string;
  renderedAt: string;
};

// Publish fan-out — copies the page's rendered HTML artifact into the
// per-publication public path, then atomically updates the publication
// row's latest_* pointer columns. Plan 011 §7.
//
// Trigger points:
//   - pages.service.ts.updateSource: after each successful save when
//     the page (or its ancestor folder) has a publication.
//   - publications.service.ts.upsert: when a publication is created or
//     its configuration changes (the new artifact comes from the
//     page's current rendered_artifact_key).
//
// Cache invalidation: when `publicOrigin` is supplied, we issue a
// `caches.default.delete` against the canonical public URL via
// `ctx.waitUntil` so the next anonymous read pulls the fresh artifact
// instead of a stale edge copy. The Cloudflare global `caches` is the
// only runtime that has the `.default` cache; on Node-mode (local dev,
// vitest) the call is a no-op. The slug for the URL is fetched from
// the underlying page/folder so callers don't need to thread it.
//
// Idempotency: copying the same content_hash to the same public key
// is a no-op (R2 overwrites with identical bytes). The latest_* row
// update is unconditional but always lands on identical values.
export async function publishFanOut(
  ctx: ServiceContext,
  input: PublishFanOutInput & { publicOrigin?: string },
): Promise<PublishFanOutResult> {
  const db = requireDb(ctx);
  const objectStore = ctx.objectStore;
  if (!objectStore) {
    throw new AppError(
      "INTERNAL_ERROR",
      "ServiceContext.objectStore is required for publish fan-out.",
      500,
    );
  }
  const publication = await get(ctx, input.publicationId);
  if (!publication) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  if (publication.revokedAt) {
    throw new AppError(
      "PUBLICATION_REVOKED",
      "Publication has been revoked.",
      409,
    );
  }
  const renderedKey = `pages/${input.workspaceId}/${input.pageId}/rendered-${input.contentHash}.html`;
  const publicKey = `pub/${input.publicationId}/${input.contentHash}.html`;
  const rendered = await objectStore.get(renderedKey);
  if (!rendered) {
    throw new AppError(
      "ARTIFACT_NOT_FOUND",
      "Rendered artifact missing for publish fan-out.",
      500,
      { rendered_key: renderedKey },
    );
  }
  // ObjectStore exposes `body` as a string. Both the R2-backed and
  // Node-FS-backed adapters in this repo follow that contract, so the
  // same call works for production and local dev.
  await objectStore.put(publicKey, rendered.body, {
    contentType: "text/html; charset=utf-8",
  });
  const now = new Date().toISOString();
  // Atomic-ish: if the D1 update fails, roll back the R2 write so we
  // don't leak orphan artifacts. Best-effort delete — if it also fails,
  // the lifecycle rule on the R2 bucket is the final backstop.
  try {
    await db
      .prepare(
        `UPDATE publications
            SET latest_artifact_key = ?2,
                latest_content_hash = ?3,
                latest_rendered_at = ?4,
                updated_at = ?4
          WHERE id = ?1`,
      )
      .bind(input.publicationId, publicKey, input.contentHash, now)
      .run();
  } catch (error) {
    ctx.waitUntil(
      Promise.resolve().then(async () => {
        try {
          await objectStore.delete(publicKey);
        } catch {
          // ignore — D1 update failure already surfaced to caller
        }
      }),
    );
    throw error;
  }
  // Delete the previous artifact (if any) — when D1 swaps the pointer
  // the old key is unreachable and would otherwise accumulate forever.
  // Skip when content_hash is unchanged (publishFanOut is idempotent
  // for the same hash and the key would equal the just-written one).
  const previousKey = publication.latestArtifactKey;
  if (previousKey && previousKey !== publicKey) {
    ctx.waitUntil(
      Promise.resolve().then(async () => {
        try {
          await objectStore.delete(previousKey);
        } catch {
          // ignore — orphan, but the new artifact is live
        }
      }),
    );
  }

  // Cache invalidation — purge the Cloudflare colo cache for the
  // canonical public URL so the next anonymous read fetches the new
  // artifact. Looks up the resource's slug since the URL uses the slug,
  // not the resource id. Best-effort: scheduled via ctx.waitUntil so
  // the response path isn't blocked.
  const purgeOrigin = input.publicOrigin ?? ctx.publicOrigin;
  if (purgeOrigin) {
    const slug = await fetchResourceSlug(
      db,
      publication.resourceType,
      publication.resourceId,
    );
    if (slug) {
      const cacheGlobal = (
        globalThis as unknown as {
          caches?: { default?: { delete(req: Request): Promise<boolean> } };
        }
      ).caches;
      const edge = cacheGlobal?.default;
      if (edge) {
        const path =
          publication.resourceType === "folder" ? `/f/${slug}` : `/p/${slug}`;
        ctx.waitUntil(
          edge.delete(new Request(`${purgeOrigin}${path}`)).catch(() => {
            // Best-effort; ignore failures.
          }),
        );
      }
    }
  }

  return {
    publicationId: input.publicationId,
    artifactKey: publicKey,
    contentHash: input.contentHash,
    renderedAt: now,
  };
}

async function fetchResourceSlug(
  db: ReturnType<typeof requireDb>,
  resourceType: PublicationResourceType,
  resourceId: string,
): Promise<string | null> {
  const table = resourceType === "folder" ? "folders" : "pages";
  const row = await db
    .prepare(`SELECT slug_id FROM ${table} WHERE id = ?1`)
    .bind(resourceId)
    .first<{ slug_id: string }>();
  return row?.slug_id ?? null;
}
