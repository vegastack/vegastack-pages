// favorites.service tests against the in-memory repo adapters.
import { describe, expect, it } from "vitest";
import { favorites as favoritesService } from "@vegastack/pages-services";
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
    name: `Favorites Service Fixture ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `favorites-svc-${crypto.randomUUID()}@example.test`,
    displayName: "Favorites Caller",
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
    title: "Favorites Test Page",
    sourceType: "markdown",
    source: "# Body",
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
  return { workspace, user, page, ctx };
}

describe("favorites.service", () => {
  it("adds a favorite and returns the envelope", async () => {
    const { workspace, user, page, ctx } = await seedFixture();
    const result = await favoritesService.add(ctx, {
      pageId: page.page.id,
    });
    expect(result.favorite).not.toBeNull();
    expect(result.favorite!.userId).toBe(user.id);
    expect(result.favorite!.pageId).toBe(page.page.id);
    expect(result.favorite!.workspaceId).toBe(workspace.id);
    // tree_version is the post-mutation hash; just assert it's a
    // workspace-navigation-shaped string and it's non-empty.
    expect(result.envelope.tree_version).toMatch(/^nav_/);
    expect(result.envelope.navigation_invalidated).toBe(true);
    expect(result.envelope.changed_resources).toContain(`page:${page.page.id}`);
    expect(result.envelope.changed_resources).toContain(
      `favorite:${page.page.id}:${user.id}`,
    );
  });

  it("returns the existing favorite on a re-add (idempotent)", async () => {
    const { page, ctx } = await seedFixture();
    const first = await favoritesService.add(ctx, {
      pageId: page.page.id,
    });
    const second = await favoritesService.add(ctx, {
      pageId: page.page.id,
    });
    expect(second.favorite!.createdAt).toBe(first.favorite!.createdAt);
  });

  it("removes a favorite and returns favorite: null", async () => {
    const { page, ctx } = await seedFixture();
    await favoritesService.add(ctx, { pageId: page.page.id });
    const result = await favoritesService.remove(ctx, {
      pageId: page.page.id,
    });
    expect(result.favorite).toBeNull();
    expect(result.envelope.tree_version).toMatch(/^nav_/);
    const remaining = await repos.favorites.listForWorkspace(
      ctx.actor.userId!,
      ctx.actor.workspaceId!,
    );
    expect(remaining).toHaveLength(0);
  });

  it("envelope reflects post-mutation tree state, not pre-mutation", async () => {
    // Regression test for audit finding F-001: tree_version was previously
    // computed before the write, so create/remove envelopes shipped the
    // PRIOR tree hash. Now that the service uses ctx.computeTreeVersion()
    // AFTER the write, adding a favorite must produce a tree_version that
    // differs from the pre-write tree_version.
    const { workspace, page, ctx } = await seedFixture();
    const navBefore = await ctx.computeTreeVersion(workspace.id);
    const result = await favoritesService.add(ctx, { pageId: page.page.id });
    expect(result.envelope.tree_version).not.toBe(navBefore);
  });

  it("rejects anonymous actors with UNAUTHORIZED", async () => {
    const { page } = await seedFixture();
    const anonCtx: ServiceContext = {
      actor: { userId: "", email: null, workspaceId: null },
      repo: repos,
      async computeTreeVersion() {
        return "nav_anonymous";
      },
      waitUntil() {
        /* noop */
      },
      log() {
        /* noop */
      },
    };
    await expect(
      favoritesService.add(anonCtx, { pageId: page.page.id }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns NOT_FOUND when the page id is unknown", async () => {
    const { ctx } = await seedFixture();
    await expect(
      favoritesService.add(ctx, { pageId: "pg_does_not_exist" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("listForWorkspace returns the actor's pinned pages", async () => {
    const { workspace, page, ctx } = await seedFixture();
    await favoritesService.add(ctx, { pageId: page.page.id });
    const list = await favoritesService.listForWorkspace(ctx, {
      workspaceId: workspace.id,
    });
    expect(list).toHaveLength(1);
    expect(list[0].pageId).toBe(page.page.id);
  });
});
