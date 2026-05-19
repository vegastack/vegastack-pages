import { describe, expect, it } from "vitest";
import * as users from "../users.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

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
    // The legacy repo registry isn't used by the users service.
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
}

describe("users.service", () => {
  it("upsert creates a new user and is idempotent by email", async () => {
    const ctx = makeCtx();
    const created = await users.upsert(ctx, {
      email: "alice@example.test",
      displayName: "Alice",
    });
    expect(created.id).toMatch(/^usr_/);
    expect(created.email).toBe("alice@example.test");
    expect(created.displayName).toBe("Alice");
    expect(created.role).toBe("user");

    const again = await users.upsert(ctx, {
      email: "alice@example.test",
      displayName: "Different Name",
    });
    expect(again.id).toBe(created.id);
    // Existing row wins — displayName from the second call is ignored.
    expect(again.displayName).toBe("Alice");
  });

  it("treats email as case-insensitive", async () => {
    const ctx = makeCtx();
    const first = await users.upsert(ctx, { email: "Foo@X.com" });
    const second = await users.upsert(ctx, { email: "foo@x.com" });
    expect(second.id).toBe(first.id);
    expect(first.email).toBe("foo@x.com");
  });

  it("getById and getByEmail return rows or null", async () => {
    const ctx = makeCtx();
    const created = await users.upsert(ctx, {
      email: "bob@example.test",
      displayName: "Bob",
      role: "instance_admin",
    });

    const byId = await users.getById(ctx, created.id);
    expect(byId?.id).toBe(created.id);
    expect(byId?.role).toBe("instance_admin");

    const byEmail = await users.getByEmail(ctx, "BOB@example.test");
    expect(byEmail?.id).toBe(created.id);

    expect(await users.getById(ctx, "usr_missing")).toBeNull();
    expect(await users.getByEmail(ctx, "nobody@example.test")).toBeNull();
  });

  it("setRole updates the role on an existing user", async () => {
    const ctx = makeCtx();
    const created = await users.upsert(ctx, { email: "carol@example.test" });
    expect(created.role).toBe("user");
    const updated = await users.setRole(ctx, {
      userId: created.id,
      role: "instance_admin",
    });
    expect(updated.role).toBe("instance_admin");
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const refetched = await users.getById(ctx, created.id);
    expect(refetched?.role).toBe("instance_admin");
  });

  it("setRole on a missing user throws USER_NOT_FOUND", async () => {
    const ctx = makeCtx();
    await expect(
      users.setRole(ctx, { userId: "usr_nope", role: "instance_admin" }),
    ).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
      status: 404,
    });
  });

  it("requires a D1 binding", async () => {
    const ctx = makeCtx();
    ctx.db = undefined;
    await expect(
      users.upsert(ctx, { email: "x@example.test" }),
    ).rejects.toThrow(/ServiceContext\.db is required/);
  });
});
