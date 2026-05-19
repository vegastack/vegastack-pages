// comments.service tests — direct-D1 via createTestD1().
//
// Plan 011 §5 phase 10. Replaces apps/web/src/lib/__tests__/
// comments-service.test.ts which exercised the in-memory CommentRepo
// adapter; this version drives the service against the same SQLite
// schema that ships to Cloudflare D1.

import { describe, expect, it } from "vitest";
import * as comments from "../comments.service.ts";
import type { CommentAnchorInput, ServiceContext } from "../index.ts";
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

function makeCtx(actorUserId = "usr_actor"): ServiceContext {
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
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
}

async function seedFixture() {
  const ctx = makeCtx("usr_actor");
  await seedWorkspace(ctx.db!, "wks_a");
  await seedUser(ctx.db!, "usr_actor");
  await seedPage(ctx.db!, "pg_a", "wks_a");
  return ctx;
}

function baseAnchor(
  contentHash = "hash-pg_a",
  overrides: Partial<CommentAnchorInput> = {},
): CommentAnchorInput {
  return {
    selectedText: "selected text",
    sourceStart: 0,
    sourceEnd: 13,
    renderedDomPath: null,
    prefixText: "",
    suffixText: "",
    contentHash,
    kind: "text",
    surface: "prose",
    selector: null,
    confidence: "active",
    ...overrides,
  };
}

// listForPage orders by created_at DESC; force the second create's
// timestamp to be strictly later than the first since two inserts inside
// the same millisecond would tie on the secondary id sort.
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("comments.service", () => {
  it("createThread inserts thread + anchor + opening reply atomically", async () => {
    const ctx = await seedFixture();
    const result = await comments.createThread(ctx, {
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "First comment",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(),
    });

    expect(result.data.thread.id).toMatch(/^thr_/);
    expect(result.data.thread.pageId).toBe("pg_a");
    expect(result.data.thread.workspaceId).toBe("wks_a");
    expect(result.data.thread.status).toBe("open");
    expect(result.data.anchor.threadId).toBe(result.data.thread.id);
    expect(result.data.anchor.confidence).toBe("active");
    expect(result.data.replies).toHaveLength(1);
    expect(result.data.replies[0]!.body).toBe("First comment");
    expect(result.envelope.changed_resources).toContain(`comments_stats:pg_a`);
    expect(result.envelope.changed_resources).toContain(
      `thread:${result.data.thread.id}`,
    );

    // Both rows actually landed in D1.
    const threadRow = await ctx
      .db!.prepare("SELECT COUNT(*) AS n FROM comment_threads")
      .bind()
      .first<{ n: number }>();
    const anchorRow = await ctx
      .db!.prepare("SELECT COUNT(*) AS n FROM comment_anchors")
      .bind()
      .first<{ n: number }>();
    const replyRow = await ctx
      .db!.prepare("SELECT COUNT(*) AS n FROM comment_replies")
      .bind()
      .first<{ n: number }>();
    expect(threadRow?.n).toBe(1);
    expect(anchorRow?.n).toBe(1);
    expect(replyRow?.n).toBe(1);
  });

  it("createThread without actor.userId throws UNAUTHORIZED on non-guest paths", async () => {
    const ctx = await seedFixture();
    ctx.actor = { userId: "", email: null, workspaceId: null };
    await expect(
      comments.createThread(ctx, {
        pageId: "pg_a",
        workspaceId: "wks_a",
        body: "no actor",
        authorUserId: null,
        guestName: null,
        guestSessionId: null,
        publicationId: null,
        anchor: baseAnchor(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("reply appends a row and bumps the thread updated_at", async () => {
    const ctx = await seedFixture();
    const created = await comments.createThread(ctx, {
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "Root",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(),
    });
    await tick();
    const replied = await comments.reply(ctx, {
      threadId: created.data.thread.id,
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "First reply",
      authorType: "user",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      agent: null,
    });

    expect(replied.data.id).toMatch(/^rpl_/);
    expect(replied.data.threadId).toBe(created.data.thread.id);
    expect(replied.envelope.changed_resources).toContain(`comments_stats:pg_a`);

    // Thread now has two replies and updated_at advanced.
    const stats = await comments.countsForPage(ctx, { pageId: "pg_a" });
    expect(stats.total).toBe(1);
    expect(stats.open).toBe(1);
    expect(stats.resolved).toBe(0);
    expect(stats.lastActivityAt).toBe(replied.data.createdAt);
  });

  it("listForPage returns threads created_at DESC and includes replies", async () => {
    const ctx = await seedFixture();
    const first = await comments.createThread(ctx, {
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "Older",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(),
    });
    await tick();
    const second = await comments.createThread(ctx, {
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "Newer",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(),
    });

    const open = await comments.listForPage(ctx, {
      pageId: "pg_a",
      status: "open",
    });
    expect(open).toHaveLength(2);
    expect(open[0]!.thread.id).toBe(second.data.thread.id);
    expect(open[1]!.thread.id).toBe(first.data.thread.id);
    // Each thread arrives hydrated with anchor + opening reply.
    expect(open[0]!.anchor.threadId).toBe(second.data.thread.id);
    expect(open[0]!.replies).toHaveLength(1);
  });

  it("resolve + unresolve toggle the thread status and resolved_at", async () => {
    const ctx = await seedFixture();
    const created = await comments.createThread(ctx, {
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "Toggle me",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(),
    });

    const resolved = await comments.resolve(ctx, {
      threadId: created.data.thread.id,
      pageId: "pg_a",
      workspaceId: "wks_a",
    });
    expect(resolved.data.status).toBe("resolved");
    expect(resolved.data.resolvedAt).not.toBeNull();

    const unresolved = await comments.unresolve(ctx, {
      threadId: created.data.thread.id,
      pageId: "pg_a",
      workspaceId: "wks_a",
    });
    expect(unresolved.data.status).toBe("open");
    expect(unresolved.data.resolvedAt).toBeNull();

    // Missing threads surface as NOT_FOUND for both operations.
    await expect(
      comments.resolve(ctx, {
        threadId: "thr_missing",
        pageId: "pg_a",
        workspaceId: "wks_a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      comments.unresolve(ctx, {
        threadId: "thr_missing",
        pageId: "pg_a",
        workspaceId: "wks_a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("updateAnchor rewrites the anchor row and persists the new confidence", async () => {
    const ctx = await seedFixture();
    const created = await comments.createThread(ctx, {
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "Anchor me",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(),
    });

    const updated = await comments.updateAnchor(ctx, {
      threadId: created.data.thread.id,
      pageId: "pg_a",
      workspaceId: "wks_a",
      anchor: baseAnchor("hash-pg_a", {
        selectedText: "updated selection",
        sourceStart: 100,
        sourceEnd: 117,
        prefixText: "before-",
        suffixText: "-after",
        confidence: "manual",
        selector: { quote: { exact: "x", prefix: "p", suffix: "s" } },
      }),
    });

    expect(updated.data.selectedText).toBe("updated selection");
    expect(updated.data.sourceStart).toBe(100);
    expect(updated.data.sourceEnd).toBe(117);
    expect(updated.data.confidence).toBe("manual");
    expect(updated.data.reanchorStatus).toBe("reanchored");
    expect(updated.envelope.changed_resources).toEqual([
      `thread:${created.data.thread.id}`,
    ]);

    // Re-read via listForPage to confirm the row was actually written.
    const open = await comments.listForPage(ctx, { pageId: "pg_a" });
    expect(open[0]!.anchor.selectedText).toBe("updated selection");
    expect(open[0]!.anchor.confidence).toBe("manual");
    expect(open[0]!.anchor.selector).toEqual({
      quote: { exact: "x", prefix: "p", suffix: "s" },
    });
  });

  it("deleteThread cascades to anchors + replies via FK ON DELETE CASCADE", async () => {
    const ctx = await seedFixture();
    const created = await comments.createThread(ctx, {
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "Delete me",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(),
    });
    await comments.reply(ctx, {
      threadId: created.data.thread.id,
      pageId: "pg_a",
      workspaceId: "wks_a",
      body: "extra reply",
      authorType: "user",
      authorUserId: "usr_actor",
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      agent: null,
    });

    const deleted = await comments.deleteThread(ctx, {
      threadId: created.data.thread.id,
      pageId: "pg_a",
      workspaceId: "wks_a",
    });
    expect(deleted.data.id).toBe(created.data.thread.id);

    // Cascading deletes wiped anchor + both replies (opening reply +
    // extra reply) along with the thread row.
    const threadRow = await ctx
      .db!.prepare("SELECT COUNT(*) AS n FROM comment_threads")
      .bind()
      .first<{ n: number }>();
    const anchorRow = await ctx
      .db!.prepare("SELECT COUNT(*) AS n FROM comment_anchors")
      .bind()
      .first<{ n: number }>();
    const replyRow = await ctx
      .db!.prepare("SELECT COUNT(*) AS n FROM comment_replies")
      .bind()
      .first<{ n: number }>();
    expect(threadRow?.n).toBe(0);
    expect(anchorRow?.n).toBe(0);
    expect(replyRow?.n).toBe(0);

    // A second delete fails NOT_FOUND.
    await expect(
      comments.deleteThread(ctx, {
        threadId: created.data.thread.id,
        pageId: "pg_a",
        workspaceId: "wks_a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("requires a D1 binding", async () => {
    const ctx = makeCtx();
    ctx.db = undefined;
    await expect(comments.listForPage(ctx, { pageId: "pg_a" })).rejects.toThrow(
      /ServiceContext\.db is required/,
    );
  });
});
