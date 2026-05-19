import { describe, expect, it } from "vitest";
import * as publications from "../publications.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedWorkspace(
  db: NonNullable<ServiceContext["db"]>,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    )
    .bind(workspaceId, `Workspace ${workspaceId}`, workspaceId, now)
    .run();
}

async function seedPage(
  db: NonNullable<ServiceContext["db"]>,
  pageId: string,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO pages
         (id, workspace_id, folder_id, title, slug, slug_id, source_type,
          object_key_current, content_hash, position, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'markdown', ?6, ?7, 1, ?8, ?8)`,
    )
    .bind(
      pageId,
      workspaceId,
      `Page ${pageId}`,
      pageId,
      `${pageId}-slug`,
      `pages/${pageId}/current.md`,
      `hash-${pageId}`,
      now,
    )
    .run();
}

function makeCtx(): ServiceContext {
  const db = createTestD1();
  return {
    actor: { userId: "", email: null, workspaceId: null },
    db,
    objectStore: {
      get: async () => null,
      put: async () => ({
        key: "x",
        body: "",
        updatedAt: new Date().toISOString(),
      }),
      delete: async () => {},
      list: async () => [],
    },
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
}

async function seedFixture() {
  const ctx = makeCtx();
  await seedWorkspace(ctx.db!, "wks_a");
  await seedPage(ctx.db!, "pg_a", "wks_a");
  return ctx;
}

describe("publications.service", () => {
  it("upsert creates a new publication with a pub_ id", async () => {
    const ctx = await seedFixture();

    const created = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
    });

    expect(created.id).toMatch(/^pub_/);
    expect(created.workspaceId).toBe("wks_a");
    expect(created.resourceType).toBe("page");
    expect(created.resourceId).toBe("pg_a");
    expect(created.permission).toBe("view");
    expect(created.expiresAt).toBeNull();
    expect(created.passwordHash).toBeNull();
    expect(created.indexingEnabled).toBe(false);
    expect(created.revokedAt).toBeNull();
    expect(created.latestArtifactKey).toBeNull();
    expect(created.latestContentHash).toBeNull();
    expect(created.latestRenderedAt).toBeNull();
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it("upsert on same (workspace, type, resourceId) updates the existing row", async () => {
    const ctx = await seedFixture();

    const first = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
      password: "hunter2",
      indexingEnabled: false,
    });

    const second = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "comment",
      indexingEnabled: true,
      // password omitted → existing hash preserved
    });

    expect(second.id).toBe(first.id);
    expect(second.permission).toBe("comment");
    expect(second.indexingEnabled).toBe(true);
    expect(second.passwordHash).toBe(first.passwordHash);
    expect(second.createdAt).toBe(first.createdAt);

    // Clearing the password with explicit null
    const third = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "comment",
      password: null,
    });
    expect(third.passwordHash).toBeNull();
  });

  it("get and findForResource roundtrip the same record", async () => {
    const ctx = await seedFixture();

    const created = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "edit",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const byId = await publications.get(ctx, created.id);
    const byResource = await publications.findForResource(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
    });

    expect(byId).toEqual(created);
    expect(byResource).toEqual(created);

    const missing = await publications.get(ctx, "pub_does_not_exist");
    expect(missing).toBeNull();

    const missingResource = await publications.findForResource(ctx, {
      workspaceId: "wks_a",
      resourceType: "folder",
      resourceId: "fld_nope",
    });
    expect(missingResource).toBeNull();
  });

  it("revoke sets revoked_at and is idempotent", async () => {
    const ctx = await seedFixture();

    const created = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
    });

    const revoked = await publications.revoke(ctx, created.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(typeof revoked.revokedAt).toBe("string");

    // Second revoke should be a no-op and preserve the original timestamp.
    const revokedAgain = await publications.revoke(ctx, created.id);
    expect(revokedAgain.revokedAt).toBe(revoked.revokedAt);

    await expect(publications.revoke(ctx, "pub_missing")).rejects.toMatchObject(
      {
        code: "PUBLICATION_NOT_FOUND",
        status: 404,
      },
    );
  });

  it("verifyPassword: correct returns true, wrong returns false, missing returns false", async () => {
    const ctx = await seedFixture();

    const created = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
      password: "correct horse battery staple",
    });

    expect(created.passwordHash).not.toBeNull();
    // PBKDF2-HMAC-SHA-256 stored as `pbkdf2$<iters>$<saltHex>$<derivedHex>`.
    // Legacy `sha256:` rows are still readable but never freshly minted.
    expect(created.passwordHash!.startsWith("pbkdf2$")).toBe(true);

    await expect(
      publications.verifyPassword(ctx, {
        publicationId: created.id,
        password: "correct horse battery staple",
      }),
    ).resolves.toBe(true);

    await expect(
      publications.verifyPassword(ctx, {
        publicationId: created.id,
        password: "wrong-password",
      }),
    ).resolves.toBe(false);

    await expect(
      publications.verifyPassword(ctx, {
        publicationId: "pub_missing",
        password: "anything",
      }),
    ).resolves.toBe(false);

    // A publication with no password set should fail verification too —
    // the caller is expected to skip verifyPassword when passwordHash
    // is null. Make sure we don't accidentally accept any password.
    await seedPage(ctx.db!, "pg_b", "wks_a");
    const noPassword = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_b",
      permission: "view",
    });
    await expect(
      publications.verifyPassword(ctx, {
        publicationId: noPassword.id,
        password: "anything",
      }),
    ).resolves.toBe(false);
  });

  it("verifyPassword: accepts legacy sha256: rows so existing data still unlocks", async () => {
    const ctx = await seedFixture();
    await seedPage(ctx.db!, "pg_legacy", "wks_a");
    const created = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_legacy",
      permission: "view",
    });
    // Simulate a row written by the pre-rebuild publications service.
    // Salt + hash computed inline so we don't hard-code a literal that
    // could drift from the legacy hasher.
    const salt = "0123456789abcdef0123456789abcdef";
    const password = "legacy-passphrase";
    const data = new TextEncoder().encode(`${salt}:${password}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const view = new Uint8Array(digest);
    let expectedHex = "";
    for (const b of view) expectedHex += b.toString(16).padStart(2, "0");
    await ctx
      .db!.prepare(
        `UPDATE publications SET password_hash = ?1, updated_at = ?2
          WHERE id = ?3`,
      )
      .bind(
        `sha256:${salt}:${expectedHex}`,
        new Date().toISOString(),
        created.id,
      )
      .run();
    await expect(
      publications.verifyPassword(ctx, {
        publicationId: created.id,
        password,
      }),
    ).resolves.toBe(true);
    await expect(
      publications.verifyPassword(ctx, {
        publicationId: created.id,
        password: "wrong",
      }),
    ).resolves.toBe(false);
  });

  it("setLatestArtifact updates the three latest_* fields", async () => {
    const ctx = await seedFixture();

    const created = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
    });

    await publications.setLatestArtifact(ctx, {
      publicationId: created.id,
      artifactKey: "publications/pg_a/v1.html",
      contentHash: "sha256:abc123",
      renderedAt: "2026-05-17T12:00:00.000Z",
    });

    const after = await publications.get(ctx, created.id);
    expect(after).not.toBeNull();
    expect(after!.latestArtifactKey).toBe("publications/pg_a/v1.html");
    expect(after!.latestContentHash).toBe("sha256:abc123");
    expect(after!.latestRenderedAt).toBe("2026-05-17T12:00:00.000Z");
    // Other fields untouched.
    expect(after!.permission).toBe("view");
    expect(after!.revokedAt).toBeNull();

    await expect(
      publications.setLatestArtifact(ctx, {
        publicationId: "pub_missing",
        artifactKey: "x",
        contentHash: "y",
        renderedAt: "2026-05-17T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_NOT_FOUND",
      status: 404,
    });
  });

  it("update with a partial patch leaves other fields untouched", async () => {
    const ctx = await seedFixture();

    const created = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
      password: "secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
      indexingEnabled: true,
    });

    const patched = await publications.update(ctx, created.id, {
      permission: "edit",
    });

    expect(patched.id).toBe(created.id);
    expect(patched.permission).toBe("edit");
    // Untouched fields preserved.
    expect(patched.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(patched.indexingEnabled).toBe(true);
    expect(patched.passwordHash).toBe(created.passwordHash);
    expect(patched.createdAt).toBe(created.createdAt);

    // Password should still verify after an unrelated patch.
    await expect(
      publications.verifyPassword(ctx, {
        publicationId: patched.id,
        password: "secret",
      }),
    ).resolves.toBe(true);

    // Explicit null clears the expiry.
    const cleared = await publications.update(ctx, created.id, {
      expiresAt: null,
    });
    expect(cleared.expiresAt).toBeNull();
    // ...but permission carried over from the previous update.
    expect(cleared.permission).toBe("edit");

    await expect(
      publications.update(ctx, "pub_missing", { permission: "view" }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_NOT_FOUND",
      status: 404,
    });
  });

  it("requires a D1 binding", async () => {
    const ctx = makeCtx();
    ctx.db = undefined;
    await expect(
      publications.findForResource(ctx, {
        workspaceId: "wks_a",
        resourceType: "page",
        resourceId: "pg_a",
      }),
    ).rejects.toThrow(/ServiceContext\.db is required/);
  });

  it("publishFanOut copies the rendered artifact into pub/ and updates latest_*", async () => {
    const ctx = await seedFixture();
    // Stub a tiny object store that knows about the rendered artifact.
    const storage = new Map<string, string>();
    const renderedKey = `pages/wks_a/pg_a/rendered-hash123.html`;
    storage.set(renderedKey, "<p>baked</p>");
    ctx.objectStore = {
      get: async (key) =>
        storage.has(key)
          ? {
              key,
              body: storage.get(key)!,
              contentType: "text/html; charset=utf-8",
              updatedAt: new Date().toISOString(),
            }
          : null,
      put: async (key, body) => {
        const text =
          typeof body === "string" ? body : new TextDecoder().decode(body);
        storage.set(key, text);
        return {
          key,
          body: text,
          contentType: "text/html; charset=utf-8",
          updatedAt: new Date().toISOString(),
        };
      },
      delete: async (key) => {
        storage.delete(key);
      },
      list: async () =>
        [...storage.entries()].map(([key, body]) => ({
          key,
          body,
          contentType: "text/html; charset=utf-8",
          updatedAt: new Date().toISOString(),
        })),
    };

    const pub = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
    });

    const result = await publications.publishFanOut(ctx, {
      publicationId: pub.id,
      workspaceId: "wks_a",
      pageId: "pg_a",
      contentHash: "hash123",
    });

    // Returned shape carries the public key and content hash.
    expect(result.publicationId).toBe(pub.id);
    expect(result.contentHash).toBe("hash123");
    expect(result.artifactKey).toBe(`pub/${pub.id}/hash123.html`);

    // R2 now has the copied public artifact.
    expect(storage.get(`pub/${pub.id}/hash123.html`)).toBe("<p>baked</p>");

    // The publication row's latest_* columns reflect the new state.
    const refreshed = await publications.get(ctx, pub.id);
    expect(refreshed?.latestArtifactKey).toBe(`pub/${pub.id}/hash123.html`);
    expect(refreshed?.latestContentHash).toBe("hash123");
    expect(refreshed?.latestRenderedAt).toBeTruthy();
  });

  it("publishFanOut throws ARTIFACT_NOT_FOUND when the rendered HTML is missing", async () => {
    const ctx = await seedFixture();
    ctx.objectStore = {
      get: async () => null,
      put: async (key, body) => ({
        key,
        body: typeof body === "string" ? body : "",
        updatedAt: new Date().toISOString(),
      }),
      delete: async () => {},
      list: async () => [],
    };

    const pub = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
    });

    await expect(
      publications.publishFanOut(ctx, {
        publicationId: pub.id,
        workspaceId: "wks_a",
        pageId: "pg_a",
        contentHash: "missing",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });

  it("publishFanOut refuses to fan out to a revoked publication", async () => {
    const ctx = await seedFixture();
    ctx.objectStore = {
      get: async () => ({
        key: "x",
        body: "<p>baked</p>",
        updatedAt: new Date().toISOString(),
      }),
      put: async () => ({
        key: "x",
        body: "",
        updatedAt: new Date().toISOString(),
      }),
      delete: async () => {},
      list: async () => [],
    };

    const pub = await publications.upsert(ctx, {
      workspaceId: "wks_a",
      resourceType: "page",
      resourceId: "pg_a",
      permission: "view",
    });
    await publications.revoke(ctx, pub.id);

    await expect(
      publications.publishFanOut(ctx, {
        publicationId: pub.id,
        workspaceId: "wks_a",
        pageId: "pg_a",
        contentHash: "h",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVOKED" });
  });
});
