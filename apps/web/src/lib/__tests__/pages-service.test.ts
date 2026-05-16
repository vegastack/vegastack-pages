// pages.service tests against the in-memory repo adapters.
import { describe, expect, it } from "vitest";
import { pages as pagesService } from "@vegastack/pages-services";
import type { ServiceContext } from "@vegastack/pages-services";
import { authService, pageService, workspaceService } from "../runtime";
import { repos } from "../runtime/repos";
import { buildWorkspaceNavigation } from "../workspace-navigation";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

async function seedFixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Pages Service Fixture ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `pages-svc-${crypto.randomUUID()}@example.test`,
    displayName: "Pages Caller",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: user.id,
    role: "admin",
  });
  const folder = workspaceService.createFolder({
    id: uniqueId("fl"),
    workspaceId: workspace.id,
    parentFolderId: null,
    name: "Topics",
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
    actor: {
      userId: user.id,
      email: user.email,
      workspaceId: workspace.id,
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
  return { workspace, user, folder, ctx };
}

describe("pages.service", () => {
  it("creates a page and returns the envelope with nav invalidation", async () => {
    const { workspace, ctx } = await seedFixture();
    const result = await pagesService.create(ctx, {
      workspaceId: workspace.id,
      folderPath: "",
      title: "Created Page",
      sourceType: "markdown",
      source: "# Hello\n\nBody.",
    });
    expect(result.data.page.title).toBe("Created Page");
    expect(result.data.source).toContain("Hello");
    expect(result.envelope.tree_version).toMatch(/^nav_/);
    expect(result.envelope.navigation_invalidated).toBe(true);
    expect(result.envelope.changed_resources).toEqual([
      `page:${result.data.page.id}`,
    ]);
  });

  it("create envelope is post-mutation (regression for F-001)", async () => {
    const { workspace, ctx } = await seedFixture();
    const navBefore = await ctx.computeTreeVersion(workspace.id);
    const result = await pagesService.create(ctx, {
      workspaceId: workspace.id,
      folderPath: "",
      title: "Post-mutation Sample",
      sourceType: "markdown",
      source: "# Body",
    });
    expect(result.envelope.tree_version).not.toBe(navBefore);
  });

  it("getByRef resolves both slug_id and pg_* id", async () => {
    const { workspace, ctx } = await seedFixture();
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Multi-Ref Page",
      sourceType: "markdown",
      source: "# Multi",
    });
    const bySlug = await pagesService.getByRef(ctx, page.page.slugId);
    const byId = await pagesService.getByRef(ctx, page.page.id);
    expect(bySlug?.page.id).toBe(page.page.id);
    expect(byId?.page.id).toBe(page.page.id);
    const missing = await pagesService.getByRef(ctx, "no-such-ref");
    expect(missing).toBeNull();
  });

  it("updateSource bumps content_hash and emits envelope", async () => {
    const { workspace, ctx } = await seedFixture();
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Update Target",
      sourceType: "markdown",
      source: "# Original",
    });
    const result = await pagesService.updateSource(ctx, {
      pageId: page.page.id,
      source: "# Original\n\nUpdated body.",
      baseVersionId: page.page.versionId,
    });
    expect(result.data.changed).toBe(true);
    expect(result.data.page.contentHash).not.toBe(page.page.contentHash);
    expect(result.envelope.content_hash).toBe(result.data.page.contentHash);
    expect(result.envelope.navigation_invalidated).toBe(true);
  });

  it("move rejects unknown folder paths with NOT_FOUND", async () => {
    const { workspace, ctx } = await seedFixture();
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Move Target",
      sourceType: "markdown",
      source: "# Body",
    });
    await expect(
      pagesService.move(ctx, {
        pageId: page.page.id,
        folderPath: "nonexistent/path",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("move into a real folder succeeds and emits envelope", async () => {
    const { workspace, folder, ctx } = await seedFixture();
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Movable Page",
      sourceType: "markdown",
      source: "# Body",
    });
    const result = await pagesService.move(ctx, {
      pageId: page.page.id,
      folderPath: folder.path,
    });
    expect(result.data.folderPath).toBe(folder.path);
    expect(result.envelope.navigation_invalidated).toBe(true);
  });

  it("restoreVersion replaces the source with a prior version and emits envelope", async () => {
    const { workspace, ctx } = await seedFixture();
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Restore Target",
      sourceType: "markdown",
      source: "# Version 1",
    });
    const firstVersionId = page.page.versionId;
    await pageService.updateSource({
      pageId: page.page.id,
      source: "# Version 2",
      baseVersionId: firstVersionId,
      checkpoint: true,
      checkpointLabel: null,
    });
    const result = await pagesService.restoreVersion(ctx, {
      pageId: page.page.id,
      versionId: firstVersionId,
    });
    expect(result.data.changed).toBe(true);
    expect(result.envelope.navigation_invalidated).toBe(true);
    const restored = await repos.pages.getById(page.page.id);
    expect(restored?.source).toContain("Version 1");
  });

  it("restoreVersion 404s when page id is unknown", async () => {
    const { ctx } = await seedFixture();
    await expect(
      pagesService.restoreVersion(ctx, {
        pageId: "pg_does_not_exist",
        versionId: "ver_anything",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // audit-cycle-3-findings.md F-021. Authorization is a caller
  // responsibility (see services/src/index.ts) — the service does not
  // enforce workspace role or per-resource permissions. It does surface
  // CONFLICT on stale baseVersionId, which clients depend on for
  // optimistic concurrency.
  it("updateSource raises CONFLICT on stale baseVersionId (concurrent edit)", async () => {
    const { workspace, ctx } = await seedFixture();
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Conflict Target",
      sourceType: "markdown",
      source: "# v1",
    });
    // First update succeeds and advances the version pointer.
    await pagesService.updateSource(ctx, {
      pageId: page.page.id,
      source: "# v2",
      baseVersionId: page.page.versionId,
    });
    // Second update with the OLD baseVersionId must fail with CONFLICT.
    await expect(
      pagesService.updateSource(ctx, {
        pageId: page.page.id,
        source: "# v3 (stale base)",
        baseVersionId: page.page.versionId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
