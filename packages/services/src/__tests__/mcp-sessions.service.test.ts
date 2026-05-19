import { describe, expect, it } from "vitest";
import { AppError } from "@vegastack/pages-core";
import * as mcpSessions from "../mcp-sessions.service.ts";
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

async function seedAgentSession(
  ctx: ServiceContext,
  workspaceId: string,
  userId: string,
) {
  await seedWorkspace(ctx.db!, workspaceId);
  await seedUser(ctx.db!, userId);
  return mcpSessions.createAgentSession(ctx, {
    workspaceId,
    userId,
    clientName: "Test MCP Client",
    clientVersion: "1.0.0",
    kind: "manual",
  });
}

describe("mcp-sessions.service: mcp sessions", () => {
  it("createMcpSession + getMcpSession roundtrip", async () => {
    const ctx = makeCtx();
    const agent = await seedAgentSession(ctx, "wks_alpha", "usr_alpha");

    const created = await mcpSessions.createMcpSession(ctx, {
      workspaceId: agent.workspaceId,
      userId: agent.userId,
      agentSessionId: agent.id,
      protocolVersion: "2025-06-18",
      scope: "read write",
      refreshTokenHash: "rth_initial",
    });

    expect(created.id).toMatch(/^mcs_/);
    expect(created.workspaceId).toBe("wks_alpha");
    expect(created.userId).toBe("usr_alpha");
    expect(created.agentSessionId).toBe(agent.id);
    expect(created.protocolVersion).toBe("2025-06-18");
    expect(created.scope).toBe("read write");
    expect(created.refreshTokenHash).toBe("rth_initial");
    // expires_at is set, and so is refresh_token_expires_at (because a
    // hash was supplied).
    expect(created.expiresAt).not.toBeNull();
    expect(created.refreshTokenExpiresAt).not.toBeNull();
    expect(Date.parse(created.refreshTokenExpiresAt!)).toBeGreaterThan(
      Date.parse(created.expiresAt!),
    );

    const fetched = await mcpSessions.getMcpSession(ctx, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.refreshTokenHash).toBe("rth_initial");
    expect(fetched!.scope).toBe("read write");
  });

  it("findByRefreshToken returns the session by its refresh-token hash", async () => {
    const ctx = makeCtx();
    const agent = await seedAgentSession(ctx, "wks_beta", "usr_beta");

    const created = await mcpSessions.createMcpSession(ctx, {
      workspaceId: agent.workspaceId,
      userId: agent.userId,
      agentSessionId: agent.id,
      refreshTokenHash: "rth_findable",
    });

    const found = await mcpSessions.findByRefreshToken(ctx, "rth_findable");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.workspaceId).toBe("wks_beta");

    // Unknown hash → null. Empty string → null without a DB call.
    expect(await mcpSessions.findByRefreshToken(ctx, "rth_missing")).toBeNull();
    expect(await mcpSessions.findByRefreshToken(ctx, "")).toBeNull();
  });

  it("rotateTokens updates the refresh hash + expires_at atomically; second rotate works", async () => {
    const ctx = makeCtx();
    const agent = await seedAgentSession(ctx, "wks_gamma", "usr_gamma");

    const created = await mcpSessions.createMcpSession(ctx, {
      workspaceId: agent.workspaceId,
      userId: agent.userId,
      agentSessionId: agent.id,
      refreshTokenHash: "rth_v1",
      ttlSeconds: 60,
    });
    const initialExpiresAt = created.expiresAt!;
    // Force a measurable gap so the rotated expires_at is strictly greater
    // than the original (test runs on millisecond-resolution clocks).
    await new Promise((resolve) => setTimeout(resolve, 5));

    const rotated1 = await mcpSessions.rotateTokens(ctx, {
      sessionId: created.id,
      newRefreshTokenHash: "rth_v2",
      ttlSeconds: 120,
      refreshTokenTtlSeconds: 3600,
    });
    expect(rotated1.id).toBe(created.id);
    expect(rotated1.refreshTokenHash).toBe("rth_v2");
    expect(Date.parse(rotated1.expiresAt!)).toBeGreaterThan(
      Date.parse(initialExpiresAt),
    );

    // The old hash must no longer resolve; the new one must.
    expect(await mcpSessions.findByRefreshToken(ctx, "rth_v1")).toBeNull();
    const found = await mcpSessions.findByRefreshToken(ctx, "rth_v2");
    expect(found?.id).toBe(created.id);

    // Second rotation off the freshly-rotated session must also succeed.
    const rotated2 = await mcpSessions.rotateTokens(ctx, {
      sessionId: created.id,
      newRefreshTokenHash: "rth_v3",
    });
    expect(rotated2.refreshTokenHash).toBe("rth_v3");
    expect(await mcpSessions.findByRefreshToken(ctx, "rth_v2")).toBeNull();
    expect((await mcpSessions.findByRefreshToken(ctx, "rth_v3"))?.id).toBe(
      created.id,
    );

    // Rotating an unknown session id throws MCP_SESSION_NOT_FOUND (404).
    await expect(
      mcpSessions.rotateTokens(ctx, {
        sessionId: "mcs_nope",
        newRefreshTokenHash: "rth_x",
      }),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "MCP_SESSION_NOT_FOUND",
      status: 404,
    } satisfies Partial<AppError>);
  });

  it("revoke kills the session — findByRefreshToken returns null and the session is expired", async () => {
    const ctx = makeCtx();
    const agent = await seedAgentSession(ctx, "wks_delta", "usr_delta");

    const created = await mcpSessions.createMcpSession(ctx, {
      workspaceId: agent.workspaceId,
      userId: agent.userId,
      agentSessionId: agent.id,
      refreshTokenHash: "rth_revokable",
    });
    expect(
      (await mcpSessions.findByRefreshToken(ctx, "rth_revokable"))?.id,
    ).toBe(created.id);

    await mcpSessions.revoke(ctx, created.id);

    // Refresh-token lookup must fail now (the partial unique index
    // excludes rows with NULL refresh_token_hash, so the row is
    // unreachable via this path).
    expect(
      await mcpSessions.findByRefreshToken(ctx, "rth_revokable"),
    ).toBeNull();

    // The row still exists (revoke doesn't delete), but the hash + expiry
    // are wiped — callers checking expiresAt > now will treat it as dead.
    const after = await mcpSessions.getMcpSession(ctx, created.id);
    expect(after).not.toBeNull();
    expect(after!.refreshTokenHash).toBeNull();
    expect(after!.refreshTokenExpiresAt).toBeNull();
    expect(Date.parse(after!.expiresAt!)).toBeLessThanOrEqual(Date.now());

    // Idempotent: revoking again, or revoking nothing, is a no-op.
    await mcpSessions.revoke(ctx, created.id);
    await mcpSessions.revoke(ctx, "");

    // listForUser still returns the (now-dead) session — listing is the
    // UI's responsibility to filter; the service doesn't hide rows.
    const listed = await mcpSessions.listForUser(ctx, {
      workspaceId: "wks_delta",
      userId: "usr_delta",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
  });
});

describe("mcp-sessions.service: agent sessions", () => {
  it("createAgentSession + touchAgentSession advances last_seen_at", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!, "wks_epsilon");
    await seedUser(ctx.db!, "usr_epsilon");

    const created = await mcpSessions.createAgentSession(ctx, {
      workspaceId: "wks_epsilon",
      userId: "usr_epsilon",
      clientName: "Claude CLI",
      clientVersion: "0.5.1",
      kind: "cli",
      userAgent: "claude-code/0.5.1",
    });
    expect(created.id).toMatch(/^agt_/);
    expect(created.clientName).toBe("Claude CLI");
    expect(created.kind).toBe("cli");
    expect(created.lastOrigin).toBeNull();
    const initialLastSeen = created.lastSeenAt;

    // Force a measurable gap so the bumped timestamp is strictly greater.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await mcpSessions.touchAgentSession(ctx, {
      sessionId: created.id,
      origin: "https://example.test",
    });

    const row = await ctx
      .db!.prepare(
        "SELECT last_seen_at, last_origin FROM agent_sessions WHERE id = ?1",
      )
      .bind(created.id)
      .first<{ last_seen_at: string; last_origin: string | null }>();
    expect(row).not.toBeNull();
    expect(Date.parse(row!.last_seen_at)).toBeGreaterThan(
      Date.parse(initialLastSeen),
    );
    expect(row!.last_origin).toBe("https://example.test");

    // A second touch without an origin must NOT clobber the recorded one
    // (the UPDATE uses COALESCE).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mcpSessions.touchAgentSession(ctx, { sessionId: created.id });
    const row2 = await ctx
      .db!.prepare(
        "SELECT last_seen_at, last_origin FROM agent_sessions WHERE id = ?1",
      )
      .bind(created.id)
      .first<{ last_seen_at: string; last_origin: string | null }>();
    expect(row2!.last_origin).toBe("https://example.test");
    expect(Date.parse(row2!.last_seen_at)).toBeGreaterThan(
      Date.parse(row!.last_seen_at),
    );
  });
});
