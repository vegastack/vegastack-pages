import { describe, expect, it } from "vitest";
import * as attachments from "../attachments.service.ts";
import type { ServiceContext } from "../context.ts";
import type { StoredObject } from "@vegastack/pages-core";
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

async function seedUser(db: NonNullable<ServiceContext["db"]>, userId: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'instance_admin', ?4, ?4)",
    )
    .bind(userId, `${userId}@example.test`, "User", now)
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

// Recording object store: tracks every put/delete call so tests can
// assert that the service correctly drives the storage layer alongside
// the D1 mutations.
function createRecordingStore() {
  const objects = new Map<string, StoredObject>();
  const calls: {
    puts: Array<{ key: string; body: string; contentType?: string }>;
    deletes: string[];
  } = { puts: [], deletes: [] };
  const store = {
    async get(key: string) {
      return objects.get(key) ?? null;
    },
    async put(
      key: string,
      body: string,
      options: { contentType?: string } = {},
    ) {
      calls.puts.push({ key, body, contentType: options.contentType });
      const stored: StoredObject = {
        key,
        body,
        contentType: options.contentType,
        updatedAt: new Date().toISOString(),
      };
      objects.set(key, stored);
      return stored;
    },
    async delete(key: string) {
      calls.deletes.push(key);
      objects.delete(key);
    },
    async list(prefix: string) {
      return [...objects.values()].filter((o) => o.key.startsWith(prefix));
    },
  };
  return { store, calls, objects };
}

function makeCtx(actorUserId = "usr_actor") {
  const db = createTestD1();
  const { store, calls, objects } = createRecordingStore();
  const ctx: ServiceContext = {
    actor: { userId: actorUserId, email: null, workspaceId: null },
    db,
    objectStore: store,
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
  return { ctx, calls, objects };
}

describe("attachments.service", () => {
  it("uploads an image with dimensions and roundtrips via get()", async () => {
    const { ctx, calls } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_img");
    await seedUser(ctx.db!, "usr_actor");
    await seedPage(ctx.db!, "pg_img", "wks_img");

    const body = "fake-png-bytes";
    const created = await attachments.upload(ctx, {
      workspaceId: "wks_img",
      pageId: "pg_img",
      filename: "diagram.png",
      contentType: "image/png",
      body,
      byteSize: body.length,
      imageWidth: 640,
      imageHeight: 480,
    });

    expect(created.id).toMatch(/^att_/);
    expect(created.objectKey).toMatch(
      /^attachments\/wks_img\/[0-9a-f]{64}\.png$/,
    );
    expect(created.imageWidth).toBe(640);
    expect(created.imageHeight).toBe(480);
    expect(created.createdBy).toBe("usr_actor");
    // PUT was called with the matching key + content type.
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]!.key).toBe(created.objectKey);
    expect(calls.puts[0]!.contentType).toBe("image/png");

    const fetched = await attachments.get(ctx, created.id);
    expect(fetched).toEqual(created);

    const byKey = await attachments.getByObjectKey(ctx, created.objectKey);
    expect(byKey?.id).toBe(created.id);
  });

  it("uploads a non-image (no dimensions) and stores null width/height", async () => {
    const { ctx } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_doc");
    await seedUser(ctx.db!, "usr_actor");
    await seedPage(ctx.db!, "pg_doc", "wks_doc");

    const body = "%PDF-1.4 fake pdf body";
    const created = await attachments.upload(ctx, {
      workspaceId: "wks_doc",
      pageId: "pg_doc",
      filename: "spec.pdf",
      contentType: "application/pdf",
      body,
      byteSize: body.length,
    });

    expect(created.imageWidth).toBeNull();
    expect(created.imageHeight).toBeNull();
    expect(created.objectKey).toMatch(
      /^attachments\/wks_doc\/[0-9a-f]{64}\.pdf$/,
    );
    expect(created.contentType).toBe("application/pdf");

    const fetched = await attachments.get(ctx, created.id);
    expect(fetched?.byteSize).toBe(body.length);
    expect(fetched?.imageWidth).toBeNull();
    expect(fetched?.imageHeight).toBeNull();

    // Missing actor → createdBy persists as null. Confirm using a
    // separate ctx so we exercise the empty-string fallback path.
    const { ctx: anonCtx } = makeCtx("");
    await seedWorkspace(anonCtx.db!, "wks_doc");
    await seedPage(anonCtx.db!, "pg_doc", "wks_doc");
    const anon = await attachments.upload(anonCtx, {
      workspaceId: "wks_doc",
      pageId: "pg_doc",
      filename: "anon.txt",
      contentType: "text/plain",
      body: "hello",
      byteSize: 5,
    });
    expect(anon.createdBy).toBeNull();
  });

  it("listForPage returns every attachment for a page, ordered by created_at", async () => {
    const { ctx } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_list");
    await seedUser(ctx.db!, "usr_actor");
    await seedPage(ctx.db!, "pg_list", "wks_list");
    await seedPage(ctx.db!, "pg_other", "wks_list");

    const first = await attachments.upload(ctx, {
      workspaceId: "wks_list",
      pageId: "pg_list",
      filename: "one.txt",
      contentType: "text/plain",
      body: "one",
      byteSize: 3,
    });
    // Force distinct created_at timestamps for ordering stability.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await attachments.upload(ctx, {
      workspaceId: "wks_list",
      pageId: "pg_list",
      filename: "two.txt",
      contentType: "text/plain",
      body: "two",
      byteSize: 3,
    });
    // Unrelated page — must not appear in the list.
    await attachments.upload(ctx, {
      workspaceId: "wks_list",
      pageId: "pg_other",
      filename: "other.txt",
      contentType: "text/plain",
      body: "other",
      byteSize: 5,
    });

    const list = await attachments.listForPage(ctx, { pageId: "pg_list" });
    expect(list.map((a) => a.id)).toEqual([first.id, second.id]);
  });

  it("remove() deletes the D1 row AND the object-store blob", async () => {
    const { ctx, calls, objects } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_rm");
    await seedUser(ctx.db!, "usr_actor");
    await seedPage(ctx.db!, "pg_rm", "wks_rm");

    const created = await attachments.upload(ctx, {
      workspaceId: "wks_rm",
      pageId: "pg_rm",
      filename: "gone.txt",
      contentType: "text/plain",
      body: "bye",
      byteSize: 3,
    });
    expect(objects.has(created.objectKey)).toBe(true);

    await attachments.remove(ctx, created.id);

    expect(calls.deletes).toEqual([created.objectKey]);
    expect(objects.has(created.objectKey)).toBe(false);
    expect(await attachments.get(ctx, created.id)).toBeNull();

    // Idempotent: removing again is a no-op (doesn't throw, doesn't
    // call objectStore.delete a second time).
    await attachments.remove(ctx, created.id);
    expect(calls.deletes).toEqual([created.objectKey]);
  });

  it("requires both a D1 binding and an ObjectStore", async () => {
    const { ctx } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_req");
    await seedPage(ctx.db!, "pg_req", "wks_req");

    // Strip the object store — upload should fail loudly.
    const noStoreCtx: ServiceContext = { ...ctx, objectStore: undefined };
    await expect(
      attachments.upload(noStoreCtx, {
        workspaceId: "wks_req",
        pageId: "pg_req",
        filename: "x.txt",
        contentType: "text/plain",
        body: "x",
        byteSize: 1,
      }),
    ).rejects.toThrow(/ServiceContext\.objectStore is required/);

    // Strip the D1 — get() should fail loudly.
    const noDbCtx: ServiceContext = { ...ctx, db: undefined };
    await expect(attachments.get(noDbCtx, "att_anything")).rejects.toThrow(
      /ServiceContext\.db is required/,
    );
  });
});
