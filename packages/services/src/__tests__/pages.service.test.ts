// pages.service tests against the in-memory D1 + recording object store.
//
// Plan 011 §5 phase 14. Mirrors the patterns from
// attachments.service.test.ts and folders.service.test.ts: each test
// builds a fresh ctx (D1 + recording store) and seeds the users,
// workspace, and any folders it needs before exercising the service.

import { describe, expect, it } from "vitest";
import type { StoredObject } from "@vegastack/pages-core";
import * as pages from "../pages.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedUser(db: NonNullable<ServiceContext["db"]>, userId: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'instance_admin', ?4, ?4)",
    )
    .bind(userId, `${userId}@example.test`, "User", now)
    .run();
}

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

async function seedFolder(
  db: NonNullable<ServiceContext["db"]>,
  args: {
    id: string;
    workspaceId: string;
    name: string;
    slug: string;
    path: string;
  },
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO folders
         (id, workspace_id, parent_folder_id, name, slug, slug_id, path,
          position, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 1, ?7, ?7)`,
    )
    .bind(
      args.id,
      args.workspaceId,
      args.name,
      args.slug,
      args.id.slice(0, 12),
      args.path,
      now,
    )
    .run();
}

// Recording object store: tracks every put/delete call so tests can
// assert that the service correctly drives the storage layer alongside
// the D1 mutations. Mirrors the helper in attachments.service.test.ts.
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

describe("pages.service", () => {
  it("create persists the page, writes the source blob, and scans flags", async () => {
    const { ctx, calls } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_create");

    const source =
      "# Heading\n\n```mermaid\nflowchart LR; A-->B\n```\n\n$$x^2$$\n";
    const result = await pages.create(ctx, {
      workspaceId: "wks_create",
      title: "Architecture Notes",
      sourceType: "markdown",
      source,
    });

    expect(result.data.page.id).toMatch(/^pg_/);
    expect(result.data.page.title).toBe("Architecture Notes");
    expect(result.data.page.slug).toBe("architecture-notes");
    expect(result.data.page.slugId).toMatch(/^architecture-notes-/);
    expect(result.data.page.folderPath).toBe("");
    expect(result.data.page.versionId).toMatch(/^ver_/);
    expect(result.data.page.objectKeyCurrent).toMatch(
      new RegExp(
        `^pages/wks_create/${result.data.page.id}/source-[0-9a-f]{64}\\.md$`,
      ),
    );
    expect(result.data.source).toBe(source);
    expect(result.envelope.tree_version).toBe("nav_test");
    expect(result.envelope.navigation_invalidated).toBe(true);
    expect(result.envelope.changed_resources).toEqual([
      `page:${result.data.page.id}`,
    ]);

    // R2 put happened before D1 — calls.puts has exactly one entry.
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]!.key).toBe(result.data.page.objectKeyCurrent);

    // Flags reflect the source: code, mermaid, and math but no
    // wardley/cytoscape/iframe.
    const row = await ctx
      .db!.prepare(
        "SELECT has_code, has_mermaid, has_math, has_wardley, has_cytoscape, has_iframe FROM pages WHERE id = ?1",
      )
      .bind(result.data.page.id)
      .first<Record<string, number>>();
    expect(row).toMatchObject({
      has_code: 1,
      has_mermaid: 1,
      has_math: 1,
      has_wardley: 0,
      has_cytoscape: 0,
      has_iframe: 0,
    });

    // Initial page_versions row was inserted with reason=system.
    const versions = await pages.listVersions(ctx, {
      pageId: result.data.page.id,
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.createdReason).toBe("system");
    expect(versions[0]!.label).toBe("Initial version");
    expect(versions[0]!.id).toBe(result.data.page.versionId);
  });

  it("create + get roundtrips the source from the object store", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_round");

    const created = await pages.create(ctx, {
      workspaceId: "wks_round",
      title: "Roundtrip",
      sourceType: "markdown",
      source: "# Roundtrip body",
    });
    const fetched = await pages.get(ctx, created.data.page.id);
    expect(fetched?.page.id).toBe(created.data.page.id);
    expect(fetched?.source).toBe("# Roundtrip body");

    const bySlug = await pages.getBySlugId(ctx, created.data.page.slugId);
    expect(bySlug?.page.id).toBe(created.data.page.id);

    // getByRef accepts both id and slug_id.
    const byRefId = await pages.getByRef(ctx, created.data.page.id);
    const byRefSlug = await pages.getByRef(ctx, created.data.page.slugId);
    expect(byRefId?.page.id).toBe(created.data.page.id);
    expect(byRefSlug?.page.id).toBe(created.data.page.id);
    expect(await pages.getByRef(ctx, "missing")).toBeNull();
  });

  it("create handles MDX with the right extension + content-type", async () => {
    const { ctx, calls } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_mdx");

    const result = await pages.create(ctx, {
      workspaceId: "wks_mdx",
      title: "MDX Page",
      sourceType: "mdx",
      source: "import Foo from './foo'\n\n<Foo />\n",
    });
    expect(result.data.page.sourceType).toBe("mdx");
    expect(result.data.page.objectKeyCurrent).toMatch(/\.mdx$/);
    expect(calls.puts[0]!.contentType).toBe("text/markdown; charset=utf-8");
  });

  it("updateSource with the correct baseVersionId succeeds and bumps version", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_update");

    const created = await pages.create(ctx, {
      workspaceId: "wks_update",
      title: "Editable",
      sourceType: "markdown",
      source: "# v1",
    });
    const firstVersionId = created.data.page.versionId;

    const updated = await pages.updateSource(ctx, {
      pageId: created.data.page.id,
      source: "# v2",
      baseVersionId: firstVersionId,
    });
    expect(updated.data.changed).toBe(true);
    expect(updated.data.page.versionId).not.toBe(firstVersionId);
    expect(updated.data.page.contentHash).not.toBe(
      created.data.page.contentHash,
    );
    expect(updated.envelope.content_hash).toBe(updated.data.page.contentHash);

    // The bytes on R2 reflect the new source.
    const refetched = await pages.get(ctx, created.data.page.id);
    expect(refetched?.source).toBe("# v2");
  });

  it("updateSource with a stale baseVersionId throws CONFLICT", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_conflict");

    const created = await pages.create(ctx, {
      workspaceId: "wks_conflict",
      title: "Conflict Target",
      sourceType: "markdown",
      source: "# v1",
    });
    // First update advances the version pointer.
    await pages.updateSource(ctx, {
      pageId: created.data.page.id,
      source: "# v2",
      baseVersionId: created.data.page.versionId,
    });
    // Second update with the OLD baseVersionId must fail with CONFLICT.
    await expect(
      pages.updateSource(ctx, {
        pageId: created.data.page.id,
        source: "# v3 (stale base)",
        baseVersionId: created.data.page.versionId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  });

  it("move into a real folder updates folder_id; bad folder throws NOT_FOUND", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_move");
    await seedFolder(ctx.db!, {
      id: "fld_topics",
      workspaceId: "wks_move",
      name: "Topics",
      slug: "topics",
      path: "/topics",
    });

    const created = await pages.create(ctx, {
      workspaceId: "wks_move",
      title: "Movable",
      sourceType: "markdown",
      source: "# Body",
    });

    const moved = await pages.move(ctx, {
      pageId: created.data.page.id,
      folderPath: "topics",
    });
    expect(moved.data.folderPath).toBe("topics");
    expect(moved.envelope.navigation_invalidated).toBe(true);

    // Read-back proves folder_id was persisted (rowToRecord resolves
    // folder path back through the folders table).
    const refetched = await pages.get(ctx, created.data.page.id);
    expect(refetched?.page.folderPath).toBe("topics");

    await expect(
      pages.move(ctx, {
        pageId: created.data.page.id,
        folderPath: "does/not/exist",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("softDelete hides the page; restore brings it back", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_delete");

    const created = await pages.create(ctx, {
      workspaceId: "wks_delete",
      title: "Doomed",
      sourceType: "markdown",
      source: "# bye",
    });
    await pages.softDelete(ctx, created.data.page.id);

    // Tombstoned: invisible to get/list/getBySlugId.
    expect(await pages.get(ctx, created.data.page.id)).toBeNull();
    expect(await pages.getBySlugId(ctx, created.data.page.slugId)).toBeNull();
    expect(await pages.list(ctx, "wks_delete")).toHaveLength(0);

    // Restore brings it back, and the page is readable again.
    const restored = await pages.restore(ctx, created.data.page.id);
    expect(restored.data.id).toBe(created.data.page.id);
    expect(await pages.get(ctx, created.data.page.id)).not.toBeNull();
    expect(await pages.list(ctx, "wks_delete")).toHaveLength(1);
  });

  it("listVersions returns history newest-first and getVersionSource fetches from R2", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_history");

    const created = await pages.create(ctx, {
      workspaceId: "wks_history",
      title: "Historic",
      sourceType: "markdown",
      source: "# v1",
    });
    const firstVersionId = created.data.page.versionId;
    // Bump the clock so created_at differs and the ORDER BY is stable.
    await new Promise((r) => setTimeout(r, 10));
    const second = await pages.updateSource(ctx, {
      pageId: created.data.page.id,
      source: "# v2",
      baseVersionId: firstVersionId,
    });

    const versions = await pages.listVersions(ctx, {
      pageId: created.data.page.id,
    });
    expect(versions).toHaveLength(2);
    // Newest first — v2 ahead of v1.
    expect(versions[0]!.id).toBe(second.data.page.versionId);
    expect(versions[1]!.id).toBe(firstVersionId);

    // getVersionSource pulls the OLD blob — proves R2 still has it.
    const v1 = await pages.getVersionSource(ctx, {
      pageId: created.data.page.id,
      versionId: firstVersionId,
    });
    expect(v1.source).toBe("# v1");
    const v2 = await pages.getVersionSource(ctx, {
      pageId: created.data.page.id,
      versionId: second.data.page.versionId,
    });
    expect(v2.source).toBe("# v2");

    // Unknown version id is a clean NOT_FOUND, not a stack trace.
    await expect(
      pages.getVersionSource(ctx, {
        pageId: created.data.page.id,
        versionId: "ver_missing",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("concurrent updateSource: only one of two parallel writes wins", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_race");

    const created = await pages.create(ctx, {
      workspaceId: "wks_race",
      title: "Race",
      sourceType: "markdown",
      source: "# original",
    });
    const baseVersionId = created.data.page.versionId;

    // Two parallel updates with the SAME baseVersionId. Whichever lands
    // first wins; the other must reject with CONFLICT. node-sqlite
    // serializes prepared-statement execution, so the second .run() sees
    // the new version_id in the WHERE clause and matches nothing.
    const settled = await Promise.allSettled([
      pages.updateSource(ctx, {
        pageId: created.data.page.id,
        source: "# winner A",
        baseVersionId,
      }),
      pages.updateSource(ctx, {
        pageId: created.data.page.id,
        source: "# winner B",
        baseVersionId,
      }),
    ]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });
  });

  it("restoreVersion replaces the source with a prior version and bumps version_id", async () => {
    const { ctx } = makeCtx();
    await seedUser(ctx.db!, "usr_actor");
    await seedWorkspace(ctx.db!, "wks_restore");

    const created = await pages.create(ctx, {
      workspaceId: "wks_restore",
      title: "Restore Target",
      sourceType: "markdown",
      source: "# v1",
    });
    const v1Id = created.data.page.versionId;
    const updated = await pages.updateSource(ctx, {
      pageId: created.data.page.id,
      source: "# v2",
      baseVersionId: v1Id,
    });
    expect(updated.data.page.versionId).not.toBe(v1Id);

    const restored = await pages.restoreVersion(ctx, {
      pageId: created.data.page.id,
      versionId: v1Id,
    });
    expect(restored.data.changed).toBe(true);
    const refetched = await pages.get(ctx, created.data.page.id);
    expect(refetched?.source).toBe("# v1");
  });
});
