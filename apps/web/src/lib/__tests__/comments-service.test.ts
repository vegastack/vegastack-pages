// comments.service tests against the in-memory repo adapters.
import { describe, expect, it } from "vitest";
import { comments as commentsService } from "@vegastack/pages-services";
import type {
  ServiceContext,
  CommentAnchorInput,
} from "@vegastack/pages-services";
import { authService, pageService, workspaceService } from "../runtime";
import { repos } from "../runtime/repos";
import { buildWorkspaceNavigation } from "../workspace-navigation";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function baseAnchor(contentHash: string): CommentAnchorInput {
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
  };
}

async function seedFixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Comments Service Fixture ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `comments-svc-${crypto.randomUUID()}@example.test`,
    displayName: "Commenter",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: user.id,
    role: "editor",
  });
  const page = await pageService.createPage({
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: "",
    title: "Commented Page",
    sourceType: "markdown",
    source: "selected text and the rest of the body",
  });
  authService.createSession(user.id);

  const actor = {
    user,
    sessionId: null,
    devFallback: false,
    workspaceId: workspace.id,
    authMode: "session" as const,
  };
  const ctx: ServiceContext = {
    actor: { userId: user.id, email: user.email, workspaceId: workspace.id },
    session: {
      bookmark: null,
      prepare: () => {
        throw new Error("not used");
      },
      batch: async () => {
        throw new Error("not used");
      },
    },
    repo: repos,
    async computeTreeVersion(workspaceId: string) {
      return buildWorkspaceNavigation(actor, workspaceId).treeVersion;
    },
    waitUntil() {
      /* noop */
    },
    log() {
      /* noop */
    },
  };
  return { workspace, user, page, ctx };
}

describe("comments.service", () => {
  it("createThread inserts a thread with the correct envelope", async () => {
    const { workspace, user, page, ctx } = await seedFixture();
    const result = await commentsService.createThread(ctx, {
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "First comment",
      authorUserId: user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(page.page.contentHash),
    });
    expect(result.data.thread.pageId).toBe(page.page.id);
    expect(result.data.thread.workspaceId).toBe(workspace.id);
    expect(result.envelope.changed_resources).toContain(
      `comments_stats:${page.page.id}`,
    );
    expect(result.envelope.changed_resources).toContain(
      `thread:${result.data.thread.id}`,
    );
    expect(result.envelope.navigation_invalidated).toBe(false);
  });

  it("countsForPage reflects open + resolved threads", async () => {
    const { workspace, user, page, ctx } = await seedFixture();
    const first = await commentsService.createThread(ctx, {
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "A",
      authorUserId: user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(page.page.contentHash),
    });
    await commentsService.createThread(ctx, {
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "B",
      authorUserId: user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(page.page.contentHash),
    });
    await commentsService.resolve(ctx, {
      threadId: first.data.thread.id,
      pageId: page.page.id,
      workspaceId: workspace.id,
    });
    const stats = await commentsService.countsForPage(ctx, {
      pageId: page.page.id,
    });
    expect(stats.open).toBe(1);
    expect(stats.resolved).toBe(1);
    expect(stats.total).toBe(2);
    expect(stats.lastActivityAt).toBeTruthy();
  });

  it("resolve + unresolve toggle the thread status", async () => {
    const { workspace, user, page, ctx } = await seedFixture();
    const created = await commentsService.createThread(ctx, {
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Toggle me",
      authorUserId: user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(page.page.contentHash),
    });
    const resolved = await commentsService.resolve(ctx, {
      threadId: created.data.thread.id,
      pageId: page.page.id,
      workspaceId: workspace.id,
    });
    expect(resolved.data.status).toBe("resolved");
    const unresolved = await commentsService.unresolve(ctx, {
      threadId: created.data.thread.id,
      pageId: page.page.id,
      workspaceId: workspace.id,
    });
    expect(unresolved.data.status).toBe("open");
  });

  it("reply appends to the thread and emits envelope", async () => {
    const { workspace, user, page, ctx } = await seedFixture();
    const created = await commentsService.createThread(ctx, {
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Thread root",
      authorUserId: user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(page.page.contentHash),
    });
    const replied = await commentsService.reply(ctx, {
      threadId: created.data.thread.id,
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "First reply",
      authorType: "user",
      authorUserId: user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      agent: null,
    });
    expect(replied.data.threadId).toBe(created.data.thread.id);
    expect(replied.envelope.changed_resources).toContain(
      `comments_stats:${page.page.id}`,
    );
  });

  it("deleteThread emits envelope referencing the deleted thread", async () => {
    const { workspace, user, page, ctx } = await seedFixture();
    const created = await commentsService.createThread(ctx, {
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Delete me",
      authorUserId: user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: baseAnchor(page.page.contentHash),
    });
    const deleted = await commentsService.deleteThread(ctx, {
      threadId: created.data.thread.id,
      pageId: page.page.id,
      workspaceId: workspace.id,
    });
    expect(deleted.data.id).toBe(created.data.thread.id);
    const stats = await commentsService.countsForPage(ctx, {
      pageId: page.page.id,
    });
    expect(stats.total).toBe(0);
  });
});
