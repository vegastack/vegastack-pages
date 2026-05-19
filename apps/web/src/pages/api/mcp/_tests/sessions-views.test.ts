import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { auth, users, workspaces } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { DELETE, GET, POST } from "../sessions";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-mcp-views-"));
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

async function seedWorkspaceWithMembers() {
  const tag = crypto.randomUUID().slice(0, 8);
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const admin = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `sessions-admin-${crypto.randomUUID()}@example.com`,
    displayName: "Sessions Admin",
    role: "user",
  });
  const editor = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `sessions-editor-${crypto.randomUUID()}@example.com`,
    displayName: "Sessions Editor",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Sessions View ${tag}`,
    slug: uniqueId("slug"),
    firstAdminUserId: admin.id,
  });
  await workspaces.addMember(seedCtx, {
    workspaceId: workspace.id,
    userId: editor.id,
    role: "editor",
  });
  return { workspace, admin, editor, seedCtx };
}

async function createSessionViaApi(
  cookies: ReturnType<typeof sessionCookies>,
  workspaceId: string,
  clientName: string,
) {
  const response = await POST({
    cookies,
    url: new URL("https://pages.example.test/api/mcp/sessions"),
    request: new Request("https://pages.example.test/api/mcp/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: workspaceId,
        client_name: clientName,
      }),
    }),
  } as never);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    token: string;
    session_id: string;
  };
}

describe("Sessions API view filtering", () => {
  it("non-admin members can create their own manual sessions", async () => {
    const { workspace, editor, seedCtx } = await seedWorkspaceWithMembers();
    const editorSession = await auth.createSession(seedCtx, {
      userId: editor.id,
    });
    const cookies = sessionCookies(editorSession.id);
    const created = await createSessionViaApi(
      cookies,
      workspace.id,
      "editor token",
    );
    expect(created.session_id).toBeTruthy();
  });

  it("view=mine returns only the caller's sessions", async () => {
    const { workspace, admin, editor, seedCtx } =
      await seedWorkspaceWithMembers();
    const adminSession = await auth.createSession(seedCtx, {
      userId: admin.id,
    });
    const editorSession = await auth.createSession(seedCtx, {
      userId: editor.id,
    });
    const adminCookies = sessionCookies(adminSession.id);
    const editorCookies = sessionCookies(editorSession.id);
    await createSessionViaApi(adminCookies, workspace.id, "admin own");
    await createSessionViaApi(editorCookies, workspace.id, "editor own");

    const mineForEditor = await GET({
      cookies: editorCookies,
      url: new URL(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}&view=mine`,
      ),
      request: new Request(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}&view=mine`,
      ),
    } as never);
    const mineBody = (await mineForEditor.json()) as {
      sessions: Array<{ userId: string; clientName: string }>;
      view: string;
    };
    expect(mineForEditor.status).toBe(200);
    expect(mineBody.view).toBe("mine");
    expect(mineBody.sessions.every((s) => s.userId === editor.id)).toBe(true);
    expect(mineBody.sessions.map((s) => s.clientName)).toContain("editor own");
    expect(mineBody.sessions.map((s) => s.clientName)).not.toContain(
      "admin own",
    );
  });

  it("view=workspace requires admin and lists all sessions in the workspace", async () => {
    const { workspace, admin, editor, seedCtx } =
      await seedWorkspaceWithMembers();
    const adminSession = await auth.createSession(seedCtx, {
      userId: admin.id,
    });
    const editorSession = await auth.createSession(seedCtx, {
      userId: editor.id,
    });
    const adminCookies = sessionCookies(adminSession.id);
    const editorCookies = sessionCookies(editorSession.id);
    await createSessionViaApi(adminCookies, workspace.id, "wks-admin");
    await createSessionViaApi(editorCookies, workspace.id, "wks-editor");

    const editorRequest = await GET({
      cookies: editorCookies,
      url: new URL(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}&view=workspace`,
      ),
      request: new Request(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}&view=workspace`,
      ),
    } as never);
    expect(editorRequest.status).toBe(403);

    const adminRequest = await GET({
      cookies: adminCookies,
      url: new URL(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}&view=workspace`,
      ),
      request: new Request(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}&view=workspace`,
      ),
    } as never);
    expect(adminRequest.status).toBe(200);
    const body = (await adminRequest.json()) as {
      sessions: Array<{ clientName: string }>;
      view: string;
    };
    expect(body.view).toBe("workspace");
    const names = body.sessions.map((s) => s.clientName);
    expect(names).toContain("wks-admin");
    expect(names).toContain("wks-editor");
  });

  it("users may revoke their own session but not someone else's", async () => {
    const { workspace, admin, editor, seedCtx } =
      await seedWorkspaceWithMembers();
    const adminSession = await auth.createSession(seedCtx, {
      userId: admin.id,
    });
    const editorSession = await auth.createSession(seedCtx, {
      userId: editor.id,
    });
    const adminCookies = sessionCookies(adminSession.id);
    const editorCookies = sessionCookies(editorSession.id);
    const adminSessionRow = await createSessionViaApi(
      adminCookies,
      workspace.id,
      "admin self",
    );
    const editorSessionRow = await createSessionViaApi(
      editorCookies,
      workspace.id,
      "editor self",
    );

    // Editor tries to revoke the admin's session → 403.
    const forbidden = await DELETE({
      cookies: editorCookies,
      request: new Request("https://pages.example.test/api/mcp/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          session_id: adminSessionRow.session_id,
        }),
      }),
    } as never);
    expect(forbidden.status).toBe(403);

    // Editor revokes their own session → 200.
    const selfRevoke = await DELETE({
      cookies: editorCookies,
      request: new Request("https://pages.example.test/api/mcp/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          session_id: editorSessionRow.session_id,
        }),
      }),
    } as never);
    expect(selfRevoke.status).toBe(200);

    // Admin can revoke anyone.
    const adminRevoke = await DELETE({
      cookies: adminCookies,
      request: new Request("https://pages.example.test/api/mcp/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          session_id: adminSessionRow.session_id,
        }),
      }),
    } as never);
    expect(adminRevoke.status).toBe(200);
  });
});
