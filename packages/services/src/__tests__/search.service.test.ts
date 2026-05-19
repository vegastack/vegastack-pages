import { describe, expect, it } from "vitest";
import * as search from "../search.service.ts";
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
  title = `Page ${pageId}`,
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
      title,
      pageId,
      `${pageId}-slug`,
      `pages/${pageId}/current.md`,
      `hash-${pageId}`,
      now,
    )
    .run();
}

async function seedFolder(
  db: NonNullable<ServiceContext["db"]>,
  folderId: string,
  workspaceId: string,
  name = `Folder ${folderId}`,
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
      folderId,
      workspaceId,
      name,
      folderId,
      `${folderId}-slug`,
      `/${name}`,
      now,
    )
    .run();
}

function makeCtx(actorUserId = "usr_search") {
  const db = createTestD1();
  const ctx: ServiceContext = {
    actor: { userId: actorUserId, email: null, workspaceId: null },
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
  return ctx;
}

function baseDoc(
  overrides: Partial<search.SearchDocument> & {
    resourceType: search.SearchResourceType;
    resourceId: string;
    workspaceId: string;
  },
): search.SearchDocument {
  return {
    pageId: null,
    folderId: null,
    title: "",
    path: "",
    headingsText: "",
    frontmatterText: "",
    bodyText: "",
    commentText: "",
    tags: "",
    url: "",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("search.service", () => {
  it("indexes a document and finds it via a body-text token", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_idx");
    await seedPage(ctx.db!, "pg_idx", "wks_idx", "Quickstart");

    await search.index(
      ctx,
      baseDoc({
        resourceType: "page",
        resourceId: "pg_idx",
        workspaceId: "wks_idx",
        pageId: "pg_idx",
        title: "Quickstart",
        path: "/Quickstart",
        bodyText: "VegaStack pages instant workspace architecture overview",
        url: "/p/pg_idx-slug",
      }),
    );

    const hits = await search.query(ctx, {
      workspaceId: "wks_idx",
      query: "architecture",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.resourceId).toBe("pg_idx");
    expect(hits[0]!.resourceType).toBe("page");
    expect(hits[0]!.title).toBe("Quickstart");
    expect(hits[0]!.url).toBe("/p/pg_idx-slug");
    // snippet() wraps the matched term with [ ].
    expect(hits[0]!.snippet).toContain("[architecture]");
  });

  it("filters by resourceType", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_filter");
    await seedPage(ctx.db!, "pg_filter", "wks_filter", "Roadmap");
    await seedFolder(ctx.db!, "fl_filter", "wks_filter", "Roadmap");

    await search.index(
      ctx,
      baseDoc({
        resourceType: "page",
        resourceId: "pg_filter",
        workspaceId: "wks_filter",
        pageId: "pg_filter",
        title: "Roadmap",
        bodyText: "milestones roadmap planning notes",
      }),
    );
    await search.index(
      ctx,
      baseDoc({
        resourceType: "folder",
        resourceId: "fl_filter",
        workspaceId: "wks_filter",
        folderId: "fl_filter",
        title: "Roadmap",
        path: "/Roadmap",
      }),
    );

    const all = await search.query(ctx, {
      workspaceId: "wks_filter",
      query: "roadmap",
    });
    expect(all).toHaveLength(2);

    const pagesOnly = await search.query(ctx, {
      workspaceId: "wks_filter",
      query: "roadmap",
      resourceTypes: ["page"],
    });
    expect(pagesOnly).toHaveLength(1);
    expect(pagesOnly[0]!.resourceType).toBe("page");

    const foldersOnly = await search.query(ctx, {
      workspaceId: "wks_filter",
      query: "roadmap",
      resourceTypes: ["folder"],
    });
    expect(foldersOnly).toHaveLength(1);
    expect(foldersOnly[0]!.resourceType).toBe("folder");
  });

  it("records and lists recent opens (most-recent first)", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_recent");
    await seedUser(ctx.db!, "usr_recent");
    await seedPage(ctx.db!, "pg_one", "wks_recent");
    await seedPage(ctx.db!, "pg_two", "wks_recent");

    await search.recordRecentOpen(ctx, {
      userId: "usr_recent",
      workspaceId: "wks_recent",
      resourceType: "page",
      resourceId: "pg_one",
    });
    // Tiny delay so last_opened_at timestamps order deterministically.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await search.recordRecentOpen(ctx, {
      userId: "usr_recent",
      workspaceId: "wks_recent",
      resourceType: "page",
      resourceId: "pg_two",
    });
    // Re-open pg_one; should bump it back to the top.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await search.recordRecentOpen(ctx, {
      userId: "usr_recent",
      workspaceId: "wks_recent",
      resourceType: "page",
      resourceId: "pg_one",
    });

    const recent = await search.listRecent(ctx, {
      userId: "usr_recent",
      workspaceId: "wks_recent",
    });
    expect(recent.map((r) => r.resourceId)).toEqual(["pg_one", "pg_two"]);
  });

  it("remove() deletes the document; subsequent query misses it", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_rm");
    await seedPage(ctx.db!, "pg_rm", "wks_rm");

    await search.index(
      ctx,
      baseDoc({
        resourceType: "page",
        resourceId: "pg_rm",
        workspaceId: "wks_rm",
        pageId: "pg_rm",
        title: "Doomed",
        bodyText: "unique-token-xyzzy",
      }),
    );
    const before = await search.query(ctx, {
      workspaceId: "wks_rm",
      query: "xyzzy",
    });
    expect(before).toHaveLength(1);

    await search.remove(ctx, {
      resourceType: "page",
      resourceId: "pg_rm",
    });

    const after = await search.query(ctx, {
      workspaceId: "wks_rm",
      query: "xyzzy",
    });
    expect(after).toEqual([]);
  });

  it("reconcileWorkspace indexes base-table rows that have no search_doc yet", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_recon");
    await seedPage(ctx.db!, "pg_recon", "wks_recon", "Reconciled Page");
    await seedFolder(ctx.db!, "fl_recon", "wks_recon", "Reconciled Folder");

    // Before reconcile: no search_documents row → query misses.
    const before = await search.query(ctx, {
      workspaceId: "wks_recon",
      query: "Reconciled",
    });
    expect(before).toEqual([]);

    const counts = await search.reconcileWorkspace(ctx, {
      workspaceId: "wks_recon",
    });
    expect(counts).toEqual({ pages: 1, folders: 1, comments: 0 });

    const after = await search.query(ctx, {
      workspaceId: "wks_recon",
      query: "Reconciled",
    });
    const ids = after.map((r) => `${r.resourceType}:${r.resourceId}`).sort();
    expect(ids).toEqual(["folder:fl_recon", "page:pg_recon"]);
  });
});
