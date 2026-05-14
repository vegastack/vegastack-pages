import { describe, expect, it } from "vitest";
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
import { GET as listWorkspaces, POST as createWorkspace } from "../index";
import {
  authService,
  pageService,
  permissionService,
  workspaceService,
} from "../../../../lib/runtime";

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

async function createWorkspaceFixture(
  input: {
    ownerRole?: "user" | "instance_admin";
    memberRole?: "reader" | "commenter" | "editor" | "admin";
  } = {},
) {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Workspace Routes ${crypto.randomUUID()}`,
  });
  const owner = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `workspace-owner-${crypto.randomUUID()}@example.test`,
    displayName: "Workspace Owner",
    role: input.ownerRole ?? "user",
  });
  const member = workspaceService.addMember({
    workspaceId: workspace.id,
    userId: owner.id,
    role: input.memberRole ?? "admin",
  });
  const session = authService.createSession(owner.id);

  return {
    workspace,
    owner,
    member,
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
    expect(folderBody.folder.path).toBe("release-notes");
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
    const page = pageService.listPages(workspace.id)[0];

    expect(pageResponse.status).toBe(200);
    expect(pageBody.url).toBe(`/p/${pageBody.slug_id}`);
    expect(pageBody.version_id).toBe(page?.versionId);
    expect(page).toMatchObject({
      id: pageBody.page_id,
      folderPath: "release-notes",
      sourceType: "html",
      title: "Launch Checklist",
    });
  });

  it("rejects page creation when the folder belongs to another workspace", async () => {
    const { workspace, cookies } = await createWorkspaceFixture();
    const other = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Other Workspace ${crypto.randomUUID()}`,
    });
    const foreignFolder = workspaceService.createFolder({
      workspaceId: other.id,
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
    const { workspace, cookies } = await createWorkspaceFixture();
    const folder = workspaceService.createFolder({
      workspaceId: workspace.id,
      name: "Counts",
    });
    await pageService.createPage({
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

    permissionService.setGrant({
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
    expect(
      workspaceService.getMember(workspace.id, invited.user.id),
    ).toBeNull();
    expect(workspaceService.getMember(workspace.id, owner.id)?.role).toBe(
      "admin",
    );
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
    expect(workspaceService.getWorkspace(created.workspace_id)?.slug).toBe(
      created.slug,
    );

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
