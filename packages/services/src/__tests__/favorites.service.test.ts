import { describe, expect, it } from "vitest";
import * as favorites from "../favorites.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedUser(db: NonNullable<ServiceContext["db"]>, userId: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'user', ?4, ?4)",
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

async function seedPage(
  db: NonNullable<ServiceContext["db"]>,
  pageId: string,
  workspaceId: string,
  createdAt?: string,
) {
  const now = createdAt ?? new Date().toISOString();
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

function makeCtx(actorUserId = "usr_actor") {
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
    // Direct-D1 services no longer touch the legacy repo registry.
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return `nav_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    },
    waitUntil() {},
    log() {},
  };
  return { ctx, db };
}

async function seedFixture(actorUserId = "usr_actor") {
  const { ctx, db } = makeCtx(actorUserId);
  await seedUser(db, actorUserId);
  await seedWorkspace(db, "wks_main");
  await seedPage(db, "pg_main", "wks_main");
  return { ctx, db };
}

describe("favorites.service", () => {
  it("adds a favorite and returns it via listForWorkspace", async () => {
    const { ctx } = await seedFixture();

    const result = await favorites.add(ctx, { pageId: "pg_main" });

    expect(result.favorite).not.toBeNull();
    expect(result.favorite!.userId).toBe("usr_actor");
    expect(result.favorite!.workspaceId).toBe("wks_main");
    expect(result.favorite!.pageId).toBe("pg_main");
    expect(result.favorite!.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(result.envelope.tree_version).toMatch(/^nav_/);
    expect(result.envelope.navigation_invalidated).toBe(true);
    expect(result.envelope.changed_resources).toContain("page:pg_main");
    expect(result.envelope.changed_resources).toContain(
      "favorite:pg_main:usr_actor",
    );

    const list = await favorites.listForWorkspace(ctx, {
      workspaceId: "wks_main",
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.pageId).toBe("pg_main");
    expect(list[0]!.createdAt).toBe(result.favorite!.createdAt);
  });

  it("is idempotent: re-adding the same favorite keeps the original created_at", async () => {
    const { ctx, db } = await seedFixture();

    const first = await favorites.add(ctx, { pageId: "pg_main" });
    // Make sure the wall clock moves so a duplicate INSERT would
    // produce a visibly different created_at if INSERT OR IGNORE were
    // broken.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await favorites.add(ctx, { pageId: "pg_main" });

    expect(second.favorite!.createdAt).toBe(first.favorite!.createdAt);

    // And the underlying table really only has one row.
    const countRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM page_favorites WHERE user_id = ?1 AND page_id = ?2",
      )
      .bind("usr_actor", "pg_main")
      .first<{ n: number }>();
    expect(countRow?.n).toBe(1);
  });

  it("removes a favorite, returns favorite: null, and clears the row", async () => {
    const { ctx, db } = await seedFixture();
    await favorites.add(ctx, { pageId: "pg_main" });

    const result = await favorites.remove(ctx, { pageId: "pg_main" });

    expect(result.favorite).toBeNull();
    expect(result.envelope.tree_version).toMatch(/^nav_/);
    expect(result.envelope.navigation_invalidated).toBe(true);
    expect(result.envelope.changed_resources).toContain(
      "favorite:pg_main:usr_actor",
    );

    const remaining = await favorites.listForWorkspace(ctx, {
      workspaceId: "wks_main",
    });
    expect(remaining).toHaveLength(0);

    const countRow = await db
      .prepare("SELECT COUNT(*) AS n FROM page_favorites")
      .first<{ n: number }>();
    expect(countRow?.n).toBe(0);

    // Remove again — should be a no-op (idempotent).
    await expect(
      favorites.remove(ctx, { pageId: "pg_main" }),
    ).resolves.toMatchObject({ favorite: null });
  });

  it("add throws NOT_FOUND when the page does not exist", async () => {
    const { ctx, db } = makeCtx();
    await seedUser(db, "usr_actor");
    await seedWorkspace(db, "wks_main");

    await expect(
      favorites.add(ctx, { pageId: "pg_does_not_exist" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("add throws UNAUTHORIZED when there is no actor user id", async () => {
    const { ctx, db } = makeCtx("");
    // Workspace + page still exist so the failure is unambiguously
    // about the missing actor, not a missing page.
    await seedWorkspace(db, "wks_main");
    await seedPage(db, "pg_main", "wks_main");

    await expect(
      favorites.add(ctx, { pageId: "pg_main" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      favorites.remove(ctx, { pageId: "pg_main" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("listForWorkspace returns favorites newest-first by created_at", async () => {
    const { ctx, db } = makeCtx();
    await seedUser(db, "usr_actor");
    await seedWorkspace(db, "wks_main");
    await seedWorkspace(db, "wks_other");
    await seedPage(db, "pg_first", "wks_main");
    await seedPage(db, "pg_second", "wks_main");
    await seedPage(db, "pg_third", "wks_main");
    await seedPage(db, "pg_elsewhere", "wks_other");

    await favorites.add(ctx, { pageId: "pg_first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await favorites.add(ctx, { pageId: "pg_second" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await favorites.add(ctx, { pageId: "pg_third" });
    // Pin a page in a different workspace — must NOT appear below.
    await favorites.add(ctx, { pageId: "pg_elsewhere" });

    const list = await favorites.listForWorkspace(ctx, {
      workspaceId: "wks_main",
    });
    expect(list.map((f) => f.pageId)).toEqual([
      "pg_third",
      "pg_second",
      "pg_first",
    ]);
  });

  it("listForWorkspace returns [] for an anonymous actor without touching D1", async () => {
    const { ctx } = makeCtx("");
    // Note: no db setup at all — proves listForWorkspace short-circuits
    // on the missing userId before issuing any query.
    const list = await favorites.listForWorkspace(ctx, {
      workspaceId: "wks_anything",
    });
    expect(list).toEqual([]);
  });
});
