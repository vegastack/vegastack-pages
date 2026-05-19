import { describe, expect, it } from "vitest";
import { AppError } from "@vegastack/pages-core";
import * as permissions from "../permissions.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedWorkspaceAndUser(
  db: ReturnType<typeof createTestD1>,
  workspaceId: string,
  userId: string,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'user', ?4, ?4)",
    )
    .bind(userId, `${userId}@example.test`, "Member", now)
    .run();
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

describe("permissions.service", () => {
  it("setGrant inserts a new row, and upserts on the same (workspace,subject,scope,target)", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");

    const inserted = await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "read",
    });
    expect(inserted.level).toBe("read");
    expect(inserted.id).toMatch(/^per_/);
    expect(inserted.subjectType).toBe("user");

    // Second setGrant with the same key overwrites level and keeps the
    // same row id (upsert preserves identity).
    const updated = await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "write",
    });
    expect(updated.level).toBe("write");
    expect(updated.id).toBe(inserted.id);
    expect(updated.createdAt).toBe(inserted.createdAt);

    const all = await permissions.listGrants(ctx, { workspaceId: "wks_acme" });
    expect(all).toHaveLength(1);
    expect(all[0].level).toBe("write");
  });

  it("deleteGrant removes the row", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "read",
    });
    expect(
      await permissions.listGrants(ctx, { workspaceId: "wks_acme" }),
    ).toHaveLength(1);

    await permissions.deleteGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
    });
    expect(
      await permissions.listGrants(ctx, { workspaceId: "wks_acme" }),
    ).toHaveLength(0);
  });

  it("deleteGrantsForSubject removes every grant for that subject in the workspace", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");
    await seedWorkspaceAndUser(ctx.db!, "wks_other", "usr_bob");

    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "read",
    });
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "page",
      targetId: "pg_a",
      level: "write",
    });
    // Different subject in the same workspace — must NOT be removed.
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_bob",
      scope: "workspace",
      targetId: "wks_acme",
      level: "read",
    });

    const result = await permissions.deleteGrantsForSubject(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
    });
    expect(result.removed).toBe(2);

    const remaining = await permissions.listGrants(ctx, {
      workspaceId: "wks_acme",
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].subjectId).toBe("usr_bob");
  });

  it("listGrants filters by workspaceId, optional subjectId and targetId", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");
    await seedWorkspaceAndUser(ctx.db!, "wks_other", "usr_bob");

    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "read",
    });
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "page",
      targetId: "pg_a",
      level: "write",
    });
    await permissions.setGrant(ctx, {
      workspaceId: "wks_other",
      subjectId: "usr_bob",
      scope: "workspace",
      targetId: "wks_other",
      level: "admin",
    });

    // Workspace scope only.
    expect(
      await permissions.listGrants(ctx, { workspaceId: "wks_acme" }),
    ).toHaveLength(2);
    expect(
      await permissions.listGrants(ctx, { workspaceId: "wks_other" }),
    ).toHaveLength(1);

    // Subject filter.
    const aliceGrants = await permissions.listGrants(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
    });
    expect(aliceGrants).toHaveLength(2);

    // Target filter.
    const pageGrants = await permissions.listGrants(ctx, {
      workspaceId: "wks_acme",
      targetId: "pg_a",
    });
    expect(pageGrants).toHaveLength(1);
    expect(pageGrants[0].scope).toBe("page");
  });

  it("resolve: a workspace-scope grant gives that level for any target in the workspace", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "write",
    });

    const onPage = await permissions.resolve(ctx, {
      workspaceId: "wks_acme",
      userId: "usr_alice",
      scope: "page",
      targetId: "pg_anything",
    });
    expect(onPage).toBe("write");

    const onFolder = await permissions.resolve(ctx, {
      workspaceId: "wks_acme",
      userId: "usr_alice",
      scope: "folder",
      targetId: "fld_xyz",
    });
    expect(onFolder).toBe("write");
  });

  it("resolve: a page-scope grant overrides workspace-scope on that page", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "read",
    });
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "page",
      targetId: "pg_target",
      level: "admin",
    });

    // On the targeted page → admin (page beats workspace).
    expect(
      await permissions.resolve(ctx, {
        workspaceId: "wks_acme",
        userId: "usr_alice",
        scope: "page",
        targetId: "pg_target",
      }),
    ).toBe("admin");

    // On a different page → workspace level still applies.
    expect(
      await permissions.resolve(ctx, {
        workspaceId: "wks_acme",
        userId: "usr_alice",
        scope: "page",
        targetId: "pg_other",
      }),
    ).toBe("read");
  });

  it("resolve: instance_admin always satisfies any required level", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_root");

    // No grants seeded; user has no member role either.
    const level = await permissions.resolve(ctx, {
      workspaceId: "wks_acme",
      userId: "usr_root",
      scope: "page",
      targetId: "pg_anything",
      instanceRole: "instance_admin",
    });
    expect(level).toBe("admin");

    // And `assert` does not throw for any level.
    await expect(
      permissions.assert(ctx, {
        workspaceId: "wks_acme",
        userId: "usr_root",
        scope: "page",
        targetId: "pg_anything",
        required: "admin",
        instanceRole: "instance_admin",
      }),
    ).resolves.toBeUndefined();
  });

  it("assert throws PERMISSION_DENIED when required > actual", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "workspace",
      targetId: "wks_acme",
      level: "read",
    });

    // read >= read should pass.
    await expect(
      permissions.assert(ctx, {
        workspaceId: "wks_acme",
        userId: "usr_alice",
        scope: "page",
        targetId: "pg_x",
        required: "read",
      }),
    ).resolves.toBeUndefined();

    // write > read should fail with PERMISSION_DENIED / 403.
    await expect(
      permissions.assert(ctx, {
        workspaceId: "wks_acme",
        userId: "usr_alice",
        scope: "page",
        targetId: "pg_x",
        required: "write",
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });

    // Verify the thrown error is an AppError instance and carries
    // useful context.
    let captured: unknown;
    try {
      await permissions.assert(ctx, {
        workspaceId: "wks_acme",
        userId: "usr_alice",
        scope: "page",
        targetId: "pg_x",
        required: "admin",
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(AppError);
    expect((captured as AppError).details).toMatchObject({
      required: "admin",
      actual: "read",
      scope: "page",
    });
  });

  it("resolve: folder-scope grant on ancestor cascades to nested page", async () => {
    const ctx = makeCtx();
    await seedWorkspaceAndUser(ctx.db!, "wks_acme", "usr_alice");
    await permissions.setGrant(ctx, {
      workspaceId: "wks_acme",
      subjectId: "usr_alice",
      scope: "folder",
      targetId: "fld_parent",
      level: "comment",
    });

    const level = await permissions.resolve(ctx, {
      workspaceId: "wks_acme",
      userId: "usr_alice",
      scope: "page",
      targetId: "pg_nested",
      folderPath: ["fld_parent"],
      memberRole: null,
    });
    expect(level).toBe("comment");
  });
});
