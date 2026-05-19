import { describe, expect, it } from "vitest";
import * as reviewEvents from "../review-events.service.ts";
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

// Force the second insert's created_at to be strictly later than the
// first, since list() orders by created_at DESC and Date.now() can
// collide at millisecond resolution on fast machines.
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("review-events.service", () => {
  it("emits and lists events newest-first for a workspace", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_a");
    await seedUser(ctx.db!, "usr_a");
    await seedPage(ctx.db!, "pg_a", "wks_a");

    const first = await reviewEvents.emit(ctx, {
      workspaceId: "wks_a",
      pageId: "pg_a",
      type: "page.published",
      actorUserId: "usr_a",
      payload: { version: 1 },
    });
    await tick();
    const second = await reviewEvents.emit(ctx, {
      workspaceId: "wks_a",
      pageId: "pg_a",
      type: "comment.created",
      actorUserId: "usr_a",
      payload: { threadId: "thr_1" },
    });

    expect(first.id).toMatch(/^rev_/);
    expect(second.id).toMatch(/^rev_/);
    expect(first.id).not.toBe(second.id);

    const events = await reviewEvents.list(ctx, { workspaceId: "wks_a" });
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe(second.id);
    expect(events[0]!.type).toBe("comment.created");
    expect(events[0]!.payload).toEqual({ threadId: "thr_1" });
    expect(events[1]!.id).toBe(first.id);
    expect(events[1]!.payload).toEqual({ version: 1 });
  });

  it("filters by pageId when provided", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_a");
    await seedPage(ctx.db!, "pg_one", "wks_a");
    await seedPage(ctx.db!, "pg_two", "wks_a");

    await reviewEvents.emit(ctx, {
      workspaceId: "wks_a",
      pageId: "pg_one",
      type: "page.updated",
    });
    await tick();
    await reviewEvents.emit(ctx, {
      workspaceId: "wks_a",
      pageId: "pg_two",
      type: "page.updated",
    });
    await tick();
    await reviewEvents.emit(ctx, {
      workspaceId: "wks_a",
      pageId: "pg_one",
      type: "page.moved",
    });

    const onlyOne = await reviewEvents.list(ctx, {
      workspaceId: "wks_a",
      pageId: "pg_one",
    });
    expect(onlyOne).toHaveLength(2);
    expect(onlyOne.map((event) => event.type)).toEqual([
      "page.moved",
      "page.updated",
    ]);
    expect(onlyOne.every((event) => event.pageId === "pg_one")).toBe(true);
  });

  it("accepts null pageId and null actor and defaults payload to {}", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_a");

    const event = await reviewEvents.emit(ctx, {
      workspaceId: "wks_a",
      type: "review.condition_met",
    });

    expect(event.pageId).toBeNull();
    expect(event.actorUserId).toBeNull();
    expect(event.payload).toEqual({});

    const listed = await reviewEvents.list(ctx, { workspaceId: "wks_a" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.pageId).toBeNull();
    expect(listed[0]!.actorUserId).toBeNull();
    expect(listed[0]!.payload).toEqual({});
  });

  it("returns an empty array for a workspace with no events", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_a");
    await seedWorkspace(ctx.db!, "wks_b");

    await reviewEvents.emit(ctx, {
      workspaceId: "wks_a",
      type: "page.created",
    });

    const otherWorkspace = await reviewEvents.list(ctx, {
      workspaceId: "wks_b",
    });
    expect(otherWorkspace).toEqual([]);
  });

  it("requires a D1 binding", async () => {
    const ctx = makeCtx();
    ctx.db = undefined;
    await expect(
      reviewEvents.list(ctx, { workspaceId: "wks_a" }),
    ).rejects.toThrow(/ServiceContext\.db is required/);
    await expect(
      reviewEvents.emit(ctx, { workspaceId: "wks_a", type: "page.created" }),
    ).rejects.toThrow(/ServiceContext\.db is required/);
  });
});
