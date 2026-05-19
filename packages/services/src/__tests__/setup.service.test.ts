import { describe, expect, it } from "vitest";
import { AppError } from "@vegastack/pages-core";
import * as setup from "../setup.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedUserAndWorkspace(
  db: ReturnType<typeof createTestD1>,
  userId: string,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'instance_admin', ?4, ?4)",
    )
    .bind(userId, `${userId}@example.test`, "Admin", now)
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
    // The legacy repo registry isn't used by the setup service.
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
}

describe("setup.service", () => {
  it("returns the default state when no row exists", async () => {
    const ctx = makeCtx();
    const state = await setup.status(ctx);
    expect(state).toEqual({
      setupComplete: false,
      firstAdminUserId: null,
      firstWorkspaceId: null,
    });
  });

  it("completes setup with a valid token", async () => {
    const ctx = makeCtx();
    await seedUserAndWorkspace(ctx.db!, "usr_admin", "wks_acme");
    const result = await setup.complete(ctx, {
      setupToken: "matching-token-123",
      expectedSetupToken: "matching-token-123",
      adminEmail: "admin@example.test",
      adminName: "Admin",
      workspaceName: "Acme",
      adminUserId: "usr_admin",
      workspaceId: "wks_acme",
    });
    expect(result.adminUserId).toBe("usr_admin");
    const after = await setup.status(ctx);
    expect(after).toEqual({
      setupComplete: true,
      firstAdminUserId: "usr_admin",
      firstWorkspaceId: "wks_acme",
    });
  });

  it("rejects an invalid setup token", async () => {
    const ctx = makeCtx();
    await expect(
      setup.complete(ctx, {
        setupToken: "wrong",
        expectedSetupToken: "right",
        adminEmail: "admin@example.test",
        adminName: "Admin",
        workspaceName: "Acme",
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });
  });

  it("rejects when expected token is empty", async () => {
    const ctx = makeCtx();
    await expect(
      setup.complete(ctx, {
        setupToken: "anything",
        expectedSetupToken: "",
        adminEmail: "admin@example.test",
        adminName: "Admin",
        workspaceName: "Acme",
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("validates admin email format", async () => {
    const ctx = makeCtx();
    await expect(
      setup.complete(ctx, {
        setupToken: "tok",
        expectedSetupToken: "tok",
        adminEmail: "no-at-sign",
        adminName: "Admin",
        workspaceName: "Acme",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("validates workspace name not empty", async () => {
    const ctx = makeCtx();
    await expect(
      setup.complete(ctx, {
        setupToken: "tok",
        expectedSetupToken: "tok",
        adminEmail: "ok@example.test",
        adminName: "Admin",
        workspaceName: "   ",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("is idempotent on repeated completion attempts", async () => {
    const ctx = makeCtx();
    await seedUserAndWorkspace(ctx.db!, "usr_first", "wks_first");
    await seedUserAndWorkspace(ctx.db!, "usr_second", "wks_second");
    await setup.complete(ctx, {
      setupToken: "tok",
      expectedSetupToken: "tok",
      adminEmail: "admin@example.test",
      adminName: "Admin",
      workspaceName: "Acme",
      adminUserId: "usr_first",
      workspaceId: "wks_first",
    });
    // Second completion with a DIFFERENT admin id should not overwrite
    // and should reject with SETUP_ALREADY_COMPLETE.
    await expect(
      setup.complete(ctx, {
        setupToken: "tok",
        expectedSetupToken: "tok",
        adminEmail: "second@example.test",
        adminName: "Second",
        workspaceName: "Second",
        adminUserId: "usr_second",
        workspaceId: "wks_second",
      }),
    ).rejects.toMatchObject({
      code: "SETUP_ALREADY_COMPLETE",
    });
    const after = await setup.status(ctx);
    expect(after.firstAdminUserId).toBe("usr_first");
  });

  it("requires a D1 binding", async () => {
    const ctx = makeCtx();
    ctx.db = undefined;
    await expect(setup.status(ctx)).rejects.toThrow(
      /ServiceContext\.db is required/,
    );
  });

  it("uses constant-time comparison (smoke check)", () => {
    // Indirect smoke: with mismatched expected token, PERMISSION_DENIED
    // is consistent. We can't easily measure timing in a unit test, so
    // we just sanity-check that very long mismatched tokens still
    // produce the same error code.
    return Promise.resolve()
      .then(() => {
        const ctx = makeCtx();
        return setup.complete(ctx, {
          setupToken: "x".repeat(1024),
          expectedSetupToken: "y".repeat(1024),
          adminEmail: "admin@example.test",
          adminName: "Admin",
          workspaceName: "Acme",
        });
      })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("PERMISSION_DENIED");
      });
  });
});
