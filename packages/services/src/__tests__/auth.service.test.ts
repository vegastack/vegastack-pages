import { describe, expect, it } from "vitest";
import * as auth from "../auth.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedUser(db: ReturnType<typeof createTestD1>, userId: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'user', ?4, ?4)",
    )
    .bind(userId, `${userId}@example.test`, "Test User", now)
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

describe("auth.service: sessions", () => {
  it("creates a session and reads it back", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_alice");
    const created = await auth.createSession(ctx, { userId: "usr_alice" });
    expect(created.id).toMatch(/^ses_/);
    expect(created.userId).toBe("usr_alice");

    const fetched = await auth.getSession(ctx, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.userId).toBe("usr_alice");
    expect(fetched!.expiresAt).toBe(created.expiresAt);
  });

  it("returns null for an expired session", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_bob");
    const created = await auth.createSession(ctx, { userId: "usr_bob" });

    // Force the row to be expired by directly rewriting expires_at.
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    await ctx
      .db!.prepare("UPDATE auth_sessions SET expires_at = ?1 WHERE id = ?2")
      .bind(pastIso, created.id)
      .run();

    const fetched = await auth.getSession(ctx, created.id);
    expect(fetched).toBeNull();
  });

  it("destroySession removes the row", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_carol");
    const created = await auth.createSession(ctx, { userId: "usr_carol" });

    await auth.destroySession(ctx, created.id);
    const fetched = await auth.getSession(ctx, created.id);
    expect(fetched).toBeNull();

    const row = await ctx
      .db!.prepare("SELECT id FROM auth_sessions WHERE id = ?1")
      .bind(created.id)
      .first();
    expect(row).toBeNull();
  });

  it("sweepExpiredSessions removes only past-due rows", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_dave");
    const fresh = await auth.createSession(ctx, { userId: "usr_dave" });
    const stale = await auth.createSession(ctx, { userId: "usr_dave" });

    await ctx
      .db!.prepare("UPDATE auth_sessions SET expires_at = ?1 WHERE id = ?2")
      .bind(new Date(Date.now() - 60_000).toISOString(), stale.id)
      .run();

    const result = await auth.sweepExpiredSessions(ctx);
    expect(result.deleted).toBe(1);

    expect(await auth.getSession(ctx, fresh.id)).not.toBeNull();
    expect(await auth.getSession(ctx, stale.id)).toBeNull();
  });
});

describe("auth.service: magic links", () => {
  it("creates and consumes a magic link (happy path)", async () => {
    const ctx = makeCtx();
    const created = await auth.createMagicLink(ctx, {
      email: "user@example.test",
      tokenHash: "hash-aaa",
      redirectTo: "/dashboard",
    });
    expect(created.id).toMatch(/^mlk_/);
    expect(created.email).toBe("user@example.test");
    expect(created.consumedAt).toBeNull();

    const consumed = await auth.consumeMagicLink(ctx, {
      tokenHash: "hash-aaa",
    });
    expect(consumed).not.toBeNull();
    expect(consumed!.id).toBe(created.id);
    expect(consumed!.email).toBe("user@example.test");
    expect(consumed!.redirectTo).toBe("/dashboard");
    expect(consumed!.consumedAt).not.toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const ctx = makeCtx();
    const consumed = await auth.consumeMagicLink(ctx, {
      tokenHash: "no-such-hash",
    });
    expect(consumed).toBeNull();
  });

  it("returns null when the same token is consumed twice", async () => {
    const ctx = makeCtx();
    await auth.createMagicLink(ctx, {
      email: "user@example.test",
      tokenHash: "hash-bbb",
      redirectTo: "/",
    });

    const first = await auth.consumeMagicLink(ctx, { tokenHash: "hash-bbb" });
    expect(first).not.toBeNull();

    // Race-equivalent second call. With the single-statement UPDATE …
    // WHERE consumed_at IS NULL contract, this MUST be null.
    const second = await auth.consumeMagicLink(ctx, { tokenHash: "hash-bbb" });
    expect(second).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const ctx = makeCtx();
    const created = await auth.createMagicLink(ctx, {
      email: "user@example.test",
      tokenHash: "hash-ccc",
      redirectTo: "/",
    });
    await ctx
      .db!.prepare("UPDATE magic_links SET expires_at = ?1 WHERE id = ?2")
      .bind(new Date(Date.now() - 60_000).toISOString(), created.id)
      .run();

    const consumed = await auth.consumeMagicLink(ctx, {
      tokenHash: "hash-ccc",
    });
    expect(consumed).toBeNull();
  });
});

describe("auth.service: identities", () => {
  it("upserts a new identity then updates the same row on second call", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_eve");
    await seedUser(ctx.db!, "usr_frank");

    const first = await auth.upsertIdentity(ctx, {
      userId: "usr_eve",
      provider: "google",
      providerSubject: "google-subject-xyz",
      email: "eve@example.test",
    });
    expect(first.id).toMatch(/^aid_/);
    expect(first.userId).toBe("usr_eve");
    expect(first.email).toBe("eve@example.test");

    // Same (provider, providerSubject), different user_id+email. UNIQUE
    // index keeps the row id stable; user_id + updated_at change.
    const second = await auth.upsertIdentity(ctx, {
      userId: "usr_frank",
      provider: "google",
      providerSubject: "google-subject-xyz",
      email: "frank@example.test",
    });
    expect(second.id).toBe(first.id);
    expect(second.userId).toBe("usr_frank");
    expect(second.email).toBe("frank@example.test");
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(first.updatedAt),
    );

    const countRow = await ctx
      .db!.prepare(
        "SELECT COUNT(*) AS n FROM auth_identities WHERE provider = ?1 AND provider_subject = ?2",
      )
      .bind("google", "google-subject-xyz")
      .first<{ n: number }>();
    expect(countRow?.n).toBe(1);
  });

  it("findIdentity returns the row by (provider, providerSubject)", async () => {
    const ctx = makeCtx();
    await seedUser(ctx.db!, "usr_grace");
    const created = await auth.upsertIdentity(ctx, {
      userId: "usr_grace",
      provider: "email",
      providerSubject: "grace@example.test",
      email: "grace@example.test",
    });

    const found = await auth.findIdentity(ctx, {
      provider: "email",
      providerSubject: "grace@example.test",
    });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.userId).toBe("usr_grace");

    const missing = await auth.findIdentity(ctx, {
      provider: "email",
      providerSubject: "nobody@example.test",
    });
    expect(missing).toBeNull();
  });
});
