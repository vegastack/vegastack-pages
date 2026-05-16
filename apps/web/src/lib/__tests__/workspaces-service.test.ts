// workspaces.service tests against the in-memory repo adapters.
import { describe, expect, it } from "vitest";
import { workspaces as workspacesService } from "@vegastack/pages-services";
import type { ServiceContext } from "@vegastack/pages-services";
import { authService, workspaceService } from "../runtime";
import { repos } from "../runtime/repos";
import { buildWorkspaceNavigation } from "../workspace-navigation";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function unusedSession() {
  return {
    bookmark: null,
    prepare: () => {
      throw new Error("not used");
    },
    batch: async () => {
      throw new Error("not used");
    },
  };
}

async function seedFixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Workspaces Service Fixture ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `wks-svc-${crypto.randomUUID()}@example.test`,
    displayName: "WS Caller",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: user.id,
    role: "admin",
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
    session: unusedSession(),
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
  return { workspace, user, ctx };
}

describe("workspaces.service", () => {
  it("whoami returns the actor's user record plus accessible workspaces", async () => {
    const { workspace, user, ctx } = await seedFixture();
    const result = await workspacesService.whoami(ctx);
    expect(result.user?.id).toBe(user.id);
    expect(result.workspaces.map((entry) => entry.id)).toContain(workspace.id);
  });

  it("whoami returns null for unauthenticated actors", async () => {
    const anonCtx: ServiceContext = {
      actor: { userId: "", email: null, workspaceId: null },
      session: unusedSession(),
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
    const result = await workspacesService.whoami(anonCtx);
    expect(result.user).toBeNull();
    expect(result.workspaces).toEqual([]);
  });

  it("list returns only workspaces the actor belongs to", async () => {
    const { workspace, ctx } = await seedFixture();
    workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Other Unrelated Workspace",
    });
    const list = await workspacesService.list(ctx);
    const ids = list.map((entry) => entry.id);
    expect(ids).toContain(workspace.id);
    expect(ids.every((id) => id !== "wks_other_unrelated")).toBe(true);
  });

  it("createFolder + reorderFolder emit nav-invalidating envelopes", async () => {
    const { workspace, ctx } = await seedFixture();
    const created = await workspacesService.createFolder(ctx, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: "Reorder Target A",
    });
    const sibling = await workspacesService.createFolder(ctx, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: "Reorder Target B",
    });
    expect(created.envelope.navigation_invalidated).toBe(true);
    expect(sibling.envelope.changed_resources).toContain(
      `folder:${sibling.data.id}`,
    );

    const moved = await workspacesService.reorderFolder(ctx, {
      folderId: sibling.data.id,
      direction: "up",
    });
    expect(moved.data.folder.id).toBe(sibling.data.id);
    expect(moved.envelope.changed_resources).toContain(
      `folder:${sibling.data.id}`,
    );
  });

  it("createFolder envelope is post-mutation (regression for F-001)", async () => {
    const { workspace, ctx } = await seedFixture();
    const navBefore = await ctx.computeTreeVersion(workspace.id);
    const created = await workspacesService.createFolder(ctx, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: "After-Mutation Folder",
    });
    expect(created.envelope.tree_version).not.toBe(navBefore);
  });

  it("removeMember 404s for an unknown member id", async () => {
    const { ctx } = await seedFixture();
    await expect(
      workspacesService.removeMember(ctx, {
        memberId: "mem_does_not_exist",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
