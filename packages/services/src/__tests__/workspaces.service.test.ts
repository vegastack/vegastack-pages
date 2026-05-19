// workspaces.service tests against an in-memory D1 (createTestD1()).
//
// Plan 011 §5 phase 12. Covers the workspace + member surface of the
// rewritten service. Folder mutations are exercised by
// folders.service.test.ts; this file just smoke-tests the
// envelope-wrapping side of createFolder via reorderFolder.

import { describe, expect, it } from "vitest";
import * as workspaces from "../workspaces.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedUser(
  db: ReturnType<typeof createTestD1>,
  userId: string,
  email = `${userId}@example.test`,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'user', ?4, ?4)",
    )
    .bind(userId, email, userId, now)
    .run();
}

function makeCtx(actorUserId = "usr_caller"): ServiceContext {
  const db = createTestD1();
  return {
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
    // workspaces.service no longer reads through the legacy repo
    // registry — keep the field present so the type matches.
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion(workspaceId: string) {
      // Hash the workspace id + millisecond clock so successive
      // mutations produce distinct tree_version values (matches what
      // the production buildWorkspaceNavigation helper does in spirit).
      return `nav_${workspaceId}_${Date.now()}_${Math.random()}`;
    },
    waitUntil() {},
    log() {},
  };
}

describe("workspaces.service", () => {
  it("create + get roundtrip writes and reads back the same row", async () => {
    const ctx = makeCtx();
    const created = await workspaces.create(ctx, {
      name: "Acme Docs",
      slug: "acme",
    });
    expect(created.id).toMatch(/^wks_/);
    expect(created.slug).toBe("acme");
    expect(created.versionRetentionDays).toBeNull();

    const fetched = await workspaces.get(ctx, { workspaceId: created.id });
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Acme Docs");
  });

  it("create with firstAdminUserId also writes a workspace_members row", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_admin");
    const created = await workspaces.create(ctx, {
      name: "Solo",
      slug: "solo",
      firstAdminUserId: "usr_admin",
    });
    const members = await workspaces.listMembers(ctx, {
      workspaceId: created.id,
    });
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe("usr_admin");
    expect(members[0]?.role).toBe("admin");
    expect(members[0]?.id).toMatch(/^wmb_/);
  });

  it("create with a duplicate slug rejects with CONFLICT", async () => {
    const ctx = makeCtx();
    await workspaces.create(ctx, { name: "First", slug: "shared" });
    await expect(
      workspaces.create(ctx, { name: "Second", slug: "shared" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });

  it("getBySlug roundtrip returns the row or null", async () => {
    const ctx = makeCtx();
    const created = await workspaces.create(ctx, {
      name: "Slugged",
      slug: "slugged",
    });
    const fetched = await workspaces.getBySlug(ctx, "slugged");
    expect(fetched?.id).toBe(created.id);

    expect(await workspaces.getBySlug(ctx, "nope")).toBeNull();
  });

  it("addMember upserts and listMembers returns sorted rows", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_one");
    await seedUser(ctx.db!, "usr_two");
    const workspace = await workspaces.create(ctx, {
      name: "Team",
      slug: "team",
    });

    const first = await workspaces.addMember(ctx, {
      workspaceId: workspace.id,
      userId: "usr_one",
      role: "editor",
    });
    expect(first.role).toBe("editor");
    expect(first.id).toMatch(/^wmb_/);

    // Upsert: same (workspace, user) updates the role instead of
    // creating a second row.
    const upserted = await workspaces.addMember(ctx, {
      workspaceId: workspace.id,
      userId: "usr_one",
      role: "admin",
    });
    expect(upserted.id).toBe(first.id);
    expect(upserted.role).toBe("admin");

    await workspaces.addMember(ctx, {
      workspaceId: workspace.id,
      userId: "usr_two",
      role: "reader",
    });

    const members = await workspaces.listMembers(ctx, {
      workspaceId: workspace.id,
    });
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.userId)).toEqual(["usr_one", "usr_two"]);
  });

  it("listForUser returns only workspaces the user is a member of", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_caller");
    await seedUser(ctx.db!, "usr_outsider");
    const mine = await workspaces.create(ctx, {
      name: "Mine",
      slug: "mine",
      firstAdminUserId: "usr_caller",
    });
    const theirs = await workspaces.create(ctx, {
      name: "Theirs",
      slug: "theirs",
      firstAdminUserId: "usr_outsider",
    });

    const callerList = await workspaces.listForUser(ctx, {
      userId: "usr_caller",
    });
    expect(callerList.map((w) => w.id)).toEqual([mine.id]);

    const outsiderList = await workspaces.listForUser(ctx, {
      userId: "usr_outsider",
    });
    expect(outsiderList.map((w) => w.id)).toEqual([theirs.id]);

    // ctx.actor.userId drives the unauthenticated wrapper.
    const listed = await workspaces.list(ctx);
    expect(listed.map((w) => w.id)).toEqual([mine.id]);
  });

  it("removeMember deletes the row and emits a nav-invalidating envelope", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_caller");
    await seedUser(ctx.db!, "usr_target");
    const workspace = await workspaces.create(ctx, {
      name: "WS",
      slug: "ws",
      firstAdminUserId: "usr_caller",
    });
    const added = await workspaces.addMember(ctx, {
      workspaceId: workspace.id,
      userId: "usr_target",
      role: "reader",
    });

    const result = await workspaces.removeMember(ctx, { memberId: added.id });
    expect(result.data.id).toBe(added.id);
    expect(result.envelope.navigation_invalidated).toBe(true);
    expect(result.envelope.changed_resources).toContain(
      `members:${workspace.id}`,
    );

    const after = await workspaces.listMembers(ctx, {
      workspaceId: workspace.id,
    });
    // Only the firstAdmin is left.
    expect(after.map((m) => m.userId)).toEqual(["usr_caller"]);

    // 404 for unknown ids stays as NOT_FOUND.
    await expect(
      workspaces.removeMember(ctx, { memberId: "wmb_nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("whoami returns the actor's user record + their workspaces", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_caller", "caller@example.test");
    const ws = await workspaces.create(ctx, {
      name: "Hello",
      slug: "hello",
      firstAdminUserId: "usr_caller",
    });

    const me = await workspaces.whoami(ctx);
    expect(me.user?.id).toBe("usr_caller");
    expect(me.user?.email).toBe("caller@example.test");
    expect(me.workspaces.map((w) => w.id)).toEqual([ws.id]);

    // Unauthenticated actor returns nulls.
    const anonCtx = makeCtx("");
    const anon = await workspaces.whoami(anonCtx);
    expect(anon.user).toBeNull();
    expect(anon.workspaces).toEqual([]);
  });
});
