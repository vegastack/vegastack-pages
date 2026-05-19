import { describe, expect, it } from "vitest";
import * as audit from "../audit.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedWorkspace(
  db: ReturnType<typeof createTestD1>,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    )
    .bind(workspaceId, "Workspace", workspaceId, now)
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

describe("audit.service", () => {
  it("records events and lists them newest-first", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_a");

    const first = await audit.record(ctx, {
      workspaceId: "wks_a",
      actorUserId: "usr_1",
      action: "page.created",
      targetType: "page",
      targetId: "pg_first",
      metadata: { title: "First" },
    });
    // Ensure distinct created_at timestamps so the DESC ordering is
    // unambiguous even on fast machines.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await audit.record(ctx, {
      workspaceId: "wks_a",
      actorUserId: "usr_1",
      action: "page.updated",
      targetType: "page",
      targetId: "pg_first",
    });

    expect(first.id).toMatch(/^aud_/);
    expect(first.metadata).toEqual({ title: "First" });
    expect(second.metadata).toEqual({});

    const rows = await audit.list(ctx, { workspaceId: "wks_a" });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(second.id);
    expect(rows[1]!.id).toBe(first.id);
    expect(rows[1]!.metadata).toEqual({ title: "First" });
  });

  it("caps list results at the requested limit (and the hard ceiling)", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_b");

    for (let index = 0; index < 5; index += 1) {
      await audit.record(ctx, {
        workspaceId: "wks_b",
        actorUserId: null,
        action: "page.viewed",
        targetType: "page",
        targetId: `pg_${index}`,
      });
    }

    const limited = await audit.list(ctx, { workspaceId: "wks_b", limit: 3 });
    expect(limited).toHaveLength(3);

    // Hard ceiling: requesting absurdly large limits should not error
    // and should not blow up; we just expect <= MAX_LIMIT rows back,
    // which here is bounded by the 5 we actually inserted.
    const capped = await audit.list(ctx, {
      workspaceId: "wks_b",
      limit: 10_000,
    });
    expect(capped).toHaveLength(5);
  });

  it("supports null workspace_id and actor_user_id for system events", async () => {
    const ctx = makeCtx();

    const systemEvent = await audit.record(ctx, {
      workspaceId: null,
      actorUserId: null,
      action: "system.boot",
      targetType: "instance",
      targetId: "inst_local",
      metadata: { node: "edge-1" },
    });

    expect(systemEvent.workspaceId).toBeNull();
    expect(systemEvent.actorUserId).toBeNull();
    expect(systemEvent.metadata).toEqual({ node: "edge-1" });

    // System events do not appear under any workspace listing.
    await seedWorkspace(ctx.db!, "wks_c");
    const workspaceListing = await audit.list(ctx, { workspaceId: "wks_c" });
    expect(workspaceListing).toEqual([]);
  });

  it("returns empty for an unrelated workspace", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_x");
    await seedWorkspace(ctx.db!, "wks_y");

    await audit.record(ctx, {
      workspaceId: "wks_x",
      actorUserId: "usr_x",
      action: "page.created",
      targetType: "page",
      targetId: "pg_x",
    });

    const other = await audit.list(ctx, { workspaceId: "wks_y" });
    expect(other).toEqual([]);
  });

  it("requires a D1 binding", async () => {
    const ctx = makeCtx();
    ctx.db = undefined;
    await expect(audit.list(ctx, { workspaceId: "wks_a" })).rejects.toThrow(
      /ServiceContext\.db is required/,
    );
    await expect(
      audit.record(ctx, {
        workspaceId: "wks_a",
        actorUserId: null,
        action: "page.created",
        targetType: "page",
        targetId: "pg_a",
      }),
    ).rejects.toThrow(/ServiceContext\.db is required/);
  });
});
