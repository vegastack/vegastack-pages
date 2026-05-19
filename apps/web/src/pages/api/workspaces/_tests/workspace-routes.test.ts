import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as createFolder } from "../[workspaceId]/folders";
import { POST as createPage } from "../[workspaceId]/pages";
import {
  GET as listWorkspaceSettings,
  PATCH as updateWorkspaceSettings,
} from "../[workspaceId]/settings";
import {
  GET as listInvites,
  POST as inviteMember,
} from "../[workspaceId]/invites";
import {
  DELETE as removeMember,
  PATCH as updateMember,
} from "../[workspaceId]/members/[memberId]";
import { POST as leaveWorkspaceRoute } from "../[workspaceId]/leave";
import { GET as listWorkspaces, POST as createWorkspace } from "../index";
import {
  auth,
  folders as foldersService,
  pages as pagesService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-workspaces-"));
});

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function sessionCookies(sessionId: string) {
  return {
    get(name: string) {
      return name === "vpg_session" ? { value: sessionId } : undefined;
    },
  } as never;
}

function apiRequest(path: string, init?: RequestInit) {
  return new Request(`https://pages.example.test${path}`, init);
}

function jsonRequest(path: string, body: unknown, init: RequestInit = {}) {
  return apiRequest(path, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  });
}

function workspacePath(workspaceId: string, suffix: string) {
  return `/api/workspaces/${workspaceId}${suffix}`;
}

// Seed the workspace, owner, member, and session via the direct-D1
// services. Routes read straight from D1, so no in-memory cache sync
// is needed.
async function createWorkspaceFixture(
  input: {
    ownerRole?: "user" | "instance_admin";
    memberRole?: "reader" | "commenter" | "editor" | "admin";
  } = {},
) {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const owner = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `workspace-owner-${crypto.randomUUID()}@example.test`,
    displayName: "Workspace Owner",
    role: input.ownerRole ?? "user",
  });
  const memberRole = input.memberRole ?? "admin";
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Workspace Routes ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: memberRole === "admin" ? owner.id : undefined,
  });
  if (memberRole !== "admin") {
    await workspaces.addMember(seedCtx, {
      workspaceId: workspace.id,
      userId: owner.id,
      role: memberRole,
    });
  }
  const session = await auth.createSession(seedCtx, { userId: owner.id });
  const member = await workspaces.getMember(seedCtx, {
    workspaceId: workspace.id,
    userId: owner.id,
  });
  if (!member) {
    throw new Error("Failed to seed workspace member.");
  }

  return {
    workspace,
    owner,
    member,
    session,
    cookies: sessionCookies(session.id),
  };
}

describe("workspace page and folder routes", () => {
  it("creates folders and pages while honoring folder ids, source types, and indexing metadata", async () => {
    const { workspace, cookies } = await createWorkspaceFixture();

    const folderResponse = await createFolder({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/folders"), {
        name: "Release Notes",
        position: 4.4,
      }),
    } as never);
    const folderBody = (await folderResponse.json()) as {
      folder: { id: string; path: string; position: number };
    };

    expect(folderResponse.status).toBe(200);
    // The direct-D1 folders.service now stores paths with a leading
    // slash (matches packages/services/src/__tests__/folders.service.test.ts);
    // the route returns the row as-is.
    expect(folderBody.folder.path).toBe("/release-notes");
    expect(folderBody.folder.position).toBe(4);

    const pageResponse = await createPage({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/pages"), {
        folder_id: folderBody.folder.id,
        title: "Launch Checklist",
        source_type: "html",
        source: "<h1>Launch</h1>",
      }),
    } as never);
    const pageBody = (await pageResponse.json()) as {
      page_id: string;
      slug_id: string;
      url: string;
      version_id: string;
    };
    // The pages route mutates through pages.create which writes to D1;
    // read back via the same direct-D1 service.
    const { ctx: readCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    const page = (await pagesService.list(readCtx, workspace.id))[0];

    expect(pageResponse.status).toBe(200);
    expect(pageBody.url).toBe(`/p/${pageBody.slug_id}`);
    expect(pageBody.version_id).toBe(page?.versionId);
    expect(page).toMatchObject({
      id: pageBody.page_id,
      // The pages.list service strips the leading slash from the folder
      // path when projecting the record for clients.
      folderPath: "release-notes",
      sourceType: "html",
      title: "Launch Checklist",
    });
  });

  it("rejects page creation when the folder belongs to another workspace", async () => {
    const { workspace, cookies, owner } = await createWorkspaceFixture();
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const other = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: `Other Workspace ${crypto.randomUUID()}`,
      firstAdminUserId: owner.id,
    });
    const { ctx: otherCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: other.id,
    });
    otherCtx.actor.userId = owner.id;
    otherCtx.actor.email = owner.email;
    const foreignFolder = await foldersService.create(otherCtx, {
      workspaceId: other.id,
      parentFolderId: null,
      name: "Private",
    });

    const response = await createPage({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/pages"), {
        folder_id: foreignFolder.id,
        title: "Should Fail",
        source: "# Nope",
      }),
    } as never);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("FOLDER_NOT_FOUND");
  });

  it("requires write permission for page and folder creation", async () => {
    const { workspace, cookies } = await createWorkspaceFixture({
      memberRole: "reader",
    });

    const folder = await createFolder({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/folders"), {
        name: "Denied",
      }),
    } as never);
    const page = await createPage({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/pages"), {
        title: "Denied",
        source: "# Denied",
      }),
    } as never);

    expect(folder.status).toBe(403);
    expect(page.status).toBe(403);
  });
});

describe("workspace settings routes", () => {
  it("returns workspace counts and rounds retention updates", async () => {
    const { workspace, owner, cookies } = await createWorkspaceFixture();
    const { ctx: ownerCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    ownerCtx.actor.userId = owner.id;
    ownerCtx.actor.email = owner.email;
    const { folders: foldersService, pages: pagesService } =
      await import("@vegastack/pages-services");
    const folder = await foldersService.create(ownerCtx, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: "Counts",
    });
    await pagesService.create(ownerCtx, {
      workspaceId: workspace.id,
      folderPath: folder.path,
      title: "Counted Page",
      sourceType: "markdown",
      source: "# Counted",
    });

    const getResponse = await listWorkspaceSettings({
      cookies,
      params: { workspaceId: workspace.id },
      request: apiRequest(workspacePath(workspace.id, "/settings")),
    } as never);
    const settings = (await getResponse.json()) as {
      counts: { members: number; folders: number; pages: number };
    };

    expect(getResponse.status).toBe(200);
    expect(settings.counts).toMatchObject({
      members: 1,
      folders: 1,
      pages: 1,
    });

    const patchResponse = await updateWorkspaceSettings({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(
        workspacePath(workspace.id, "/settings"),
        {
          name: "Renamed Workspace",
          slug: "renamed-workspace",
          version_retention_days: 12.6,
        },
        { method: "PATCH" },
      ),
    } as never);
    const updated = (await patchResponse.json()) as {
      workspace: {
        name: string;
        slug: string;
        versionRetentionDays: number | null;
      };
    };

    expect(patchResponse.status).toBe(200);
    expect(updated.workspace).toMatchObject({
      name: "Renamed Workspace",
      slug: "renamed-workspace",
      versionRetentionDays: 13,
    });
  });

  it("rejects invalid retention windows and non-admin settings access", async () => {
    const { workspace, cookies } = await createWorkspaceFixture({
      memberRole: "editor",
    });

    const denied = await listWorkspaceSettings({
      cookies,
      params: { workspaceId: workspace.id },
      request: apiRequest(workspacePath(workspace.id, "/settings")),
    } as never);
    expect(denied.status).toBe(403);

    const adminFixture = await createWorkspaceFixture();
    const invalid = await updateWorkspaceSettings({
      cookies: adminFixture.cookies,
      params: { workspaceId: adminFixture.workspace.id },
      request: jsonRequest(
        workspacePath(adminFixture.workspace.id, "/settings"),
        { version_retention_days: 0 },
        { method: "PATCH" },
      ),
    } as never);
    const body = (await invalid.json()) as { error: { code: string } };

    expect(invalid.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("workspace invite and member routes", () => {
  it("invites, lists, updates, and removes workspace members", async () => {
    const { workspace, owner, cookies } = await createWorkspaceFixture();
    const invitedEmail = `invited-${crypto.randomUUID()}@example.test`;

    const inviteResponse = await inviteMember({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/invites"), {
        email: invitedEmail,
        display_name: "Invited User",
        role: "commenter",
        send_magic_link: false,
      }),
      url: new URL(
        `https://pages.example.test${workspacePath(workspace.id, "/invites")}`,
      ),
    } as never);
    const invited = (await inviteResponse.json()) as {
      user: { id: string; email: string; displayName: string };
      member: { id: string; role: string; user: { email: string } };
      magic_link_created: boolean;
      existing_member: boolean;
    };

    expect(inviteResponse.status).toBe(200);
    expect(invited.user).toMatchObject({
      email: invitedEmail,
      displayName: "Invited User",
    });
    expect(invited.member.role).toBe("commenter");
    expect(invited.magic_link_created).toBe(false);
    expect(invited.existing_member).toBe(false);
    // Mirror D1 rows written by the invite route into the legacy
    // in-memory caches that the member PATCH/DELETE routes consult.

    const listResponse = await listInvites({
      cookies,
      params: { workspaceId: workspace.id },
      request: apiRequest(workspacePath(workspace.id, "/invites")),
    } as never);
    const list = (await listResponse.json()) as {
      members: Array<{ userId: string }>;
    };
    expect(list.members.map((member) => member.userId)).toContain(
      invited.user.id,
    );

    const updateResponse = await updateMember({
      cookies,
      params: { workspaceId: workspace.id, memberId: invited.member.id },
      request: jsonRequest(
        `${workspacePath(workspace.id, "/members")}/${invited.member.id}`,
        { role: "editor", display_name: "Editor User" },
        { method: "PATCH" },
      ),
    } as never);
    const updated = (await updateResponse.json()) as {
      member: { role: string; user: { displayName: string } };
    };
    expect(updateResponse.status).toBe(200);
    expect(updated.member).toMatchObject({
      role: "editor",
      user: { displayName: "Editor User" },
    });

    const { ctx: grantCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    grantCtx.actor.userId = owner.id;
    grantCtx.actor.email = owner.email;
    const { permissions: permissionsService } =
      await import("@vegastack/pages-services");
    await permissionsService.setGrant(grantCtx, {
      workspaceId: workspace.id,
      subjectId: invited.user.id,
      scope: "workspace",
      targetId: workspace.id,
      level: "read",
    });
    const removeResponse = await removeMember({
      cookies,
      params: { workspaceId: workspace.id, memberId: invited.member.id },
      request: apiRequest(
        `${workspacePath(workspace.id, "/members")}/${invited.member.id}`,
        { method: "DELETE" },
      ),
    } as never);
    const removed = (await removeResponse.json()) as {
      removed_grants: number;
      revoked_mcp_sessions: number;
    };

    expect(removeResponse.status).toBe(200);
    expect(removed.removed_grants).toBe(1);
    expect(removed.revoked_mcp_sessions).toBe(0);
    // Verify state through D1.
    const stillMemberRemoved = await workspaces.getMember(grantCtx, {
      workspaceId: workspace.id,
      userId: invited.user.id,
    });
    expect(stillMemberRemoved).toBeNull();
    const ownerMember = await workspaces.getMember(grantCtx, {
      workspaceId: workspace.id,
      userId: owner.id,
    });
    expect(ownerMember?.role).toBe("admin");
  });

  it("rejects invalid roles and self-demotion through member APIs", async () => {
    const { workspace, member, cookies } = await createWorkspaceFixture();

    const invalidRole = await inviteMember({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/invites"), {
        email: `invalid-role-${crypto.randomUUID()}@example.test`,
        role: "owner",
        send_magic_link: false,
      }),
      url: new URL(
        `https://pages.example.test${workspacePath(workspace.id, "/invites")}`,
      ),
    } as never);
    expect(invalidRole.status).toBe(400);

    const selfDemotion = await updateMember({
      cookies,
      params: { workspaceId: workspace.id, memberId: member.id },
      request: jsonRequest(
        `${workspacePath(workspace.id, "/members")}/${member.id}`,
        { role: "reader" },
        { method: "PATCH" },
      ),
    } as never);
    expect(selfDemotion.status).toBe(400);

    const selfRemoval = await removeMember({
      cookies,
      params: { workspaceId: workspace.id, memberId: member.id },
      request: apiRequest(
        `${workspacePath(workspace.id, "/members")}/${member.id}`,
        {
          method: "DELETE",
        },
      ),
    } as never);
    expect(selfRemoval.status).toBe(400);
  });

  it("allows a member to edit their own display name without admin permission", async () => {
    const fixture = await createWorkspaceFixture({ memberRole: "reader" });
    const response = await updateMember({
      cookies: fixture.cookies,
      params: {
        workspaceId: fixture.workspace.id,
        memberId: fixture.member.id,
      },
      request: jsonRequest(
        `${workspacePath(fixture.workspace.id, "/members")}/${fixture.member.id}`,
        { role: "reader", display_name: "Renamed Self" },
        { method: "PATCH" },
      ),
    } as never);
    const body = (await response.json()) as {
      member: { user: { displayName: string }; role: string };
    };
    expect(response.status).toBe(200);
    expect(body.member.user.displayName).toBe("Renamed Self");
    expect(body.member.role).toBe("reader");
  });

  it("lets a member leave a workspace and revokes grants and MCP sessions", async () => {
    const owner = await createWorkspaceFixture();
    const leavingEmail = `leaver-${crypto.randomUUID()}@example.test`;
    const invite = await inviteMember({
      cookies: owner.cookies,
      params: { workspaceId: owner.workspace.id },
      request: jsonRequest(workspacePath(owner.workspace.id, "/invites"), {
        email: leavingEmail,
        display_name: "Leaving User",
        role: "editor",
        send_magic_link: false,
      }),
      url: new URL(
        `https://pages.example.test${workspacePath(owner.workspace.id, "/invites")}`,
      ),
    } as never);
    const invited = (await invite.json()) as {
      user: { id: string };
      member: { id: string };
    };
    expect(invite.status).toBe(200);

    const { ctx: leavingSeedCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: owner.workspace.id,
    });
    // Invite-route writes the user + workspace_members row directly to
    // D1 today; only the auth session and the workspace grant remain.
    leavingSeedCtx.actor.userId = owner.owner.id;
    leavingSeedCtx.actor.email = owner.owner.email;
    const leavingSession = await auth.createSession(leavingSeedCtx, {
      userId: invited.user.id,
    });
    const { permissions } = await import("@vegastack/pages-services");
    await permissions.setGrant(leavingSeedCtx, {
      workspaceId: owner.workspace.id,
      subjectId: invited.user.id,
      scope: "workspace",
      targetId: owner.workspace.id,
      level: "write",
    });

    const leaveResponse = await leaveWorkspaceRoute({
      cookies: sessionCookies(leavingSession.id),
      params: { workspaceId: owner.workspace.id },
      request: jsonRequest(workspacePath(owner.workspace.id, "/leave"), {}),
    } as never);
    const leaveBody = (await leaveResponse.json()) as {
      removed_grants: number;
    };
    expect(leaveResponse.status).toBe(200);
    expect(leaveBody.removed_grants).toBe(1);
    // Verify via the D1-direct workspaces service — legacy in-memory
    // cache wasn't refreshed by the route (only test fixtures refresh).
    const { ctx: verifyCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: owner.workspace.id,
    });
    verifyCtx.actor.userId = owner.owner.id;
    verifyCtx.actor.email = owner.owner.email;
    const stillMember = await workspaces.getMember(verifyCtx, {
      workspaceId: owner.workspace.id,
      userId: invited.user.id,
    });
    expect(stillMember).toBeNull();
  });

  it("blocks the last admin from leaving the workspace", async () => {
    const { workspace, cookies } = await createWorkspaceFixture();
    const response = await leaveWorkspaceRoute({
      cookies,
      params: { workspaceId: workspace.id },
      request: jsonRequest(workspacePath(workspace.id, "/leave"), {}),
    } as never);
    expect(response.status).toBe(400);
  });
});

describe("workspace collection route", () => {
  it("lists selectable workspaces for authenticated users", async () => {
    const { workspace, cookies } = await createWorkspaceFixture();

    const response = await listWorkspaces({
      cookies,
      request: apiRequest("/api/workspaces"),
    } as never);
    const body = (await response.json()) as {
      workspaces: Array<{ id: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.workspaces.map((item) => item.id)).toContain(workspace.id);
  });

  it("lets instance admins create workspaces and rejects regular users", async () => {
    const adminFixture = await createWorkspaceFixture({
      ownerRole: "instance_admin",
    });
    const createdResponse = await createWorkspace({
      cookies: adminFixture.cookies,
      request: jsonRequest("/api/workspaces", {
        name: "Created By Instance Admin",
        slug: `created-${crypto.randomUUID()}`,
      }),
    } as never);
    const created = (await createdResponse.json()) as {
      workspace_id: string;
      slug: string;
    };

    expect(createdResponse.status).toBe(200);
    // POST /api/workspaces writes via the D1-direct workspaces service;
    // verify via the same service rather than the legacy cache.
    const { ctx: verifyCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const verified = await workspaces.get(verifyCtx, {
      workspaceId: created.workspace_id,
    });
    expect(verified?.slug).toBe(created.slug);

    const regularFixture = await createWorkspaceFixture();
    const denied = await createWorkspace({
      cookies: regularFixture.cookies,
      request: jsonRequest("/api/workspaces", {
        name: "Denied Workspace",
      }),
    } as never);
    expect(denied.status).toBe(403);
  });
});
