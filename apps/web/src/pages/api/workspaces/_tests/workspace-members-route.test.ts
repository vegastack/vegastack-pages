import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as getMembers } from "../[workspaceId]/members";
import {
  auth,
  users,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-members-test-"));
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

async function fixture() {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const admin = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `members-admin-${crypto.randomUUID()}@example.test`,
    displayName: "Members Admin",
    role: "user",
  });
  const workspace = await workspacesService.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Members ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: admin.id,
  });
  const second = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `members-reader-${crypto.randomUUID()}@example.test`,
    displayName: "Reader",
    role: "user",
  });
  await workspacesService.addMember(seedCtx, {
    workspaceId: workspace.id,
    userId: second.id,
    role: "reader",
  });
  return { workspace, admin, second };
}

describe("GET /api/workspaces/[id]/members", () => {
  it("returns members with joined user identity (email + display name)", async () => {
    const { workspace, admin, second } = await fixture();
    const { ctx: sessionCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const session = await auth.createSession(sessionCtx, { userId: admin.id });
    const cookies = sessionCookies(session.id);
    const response = await getMembers({
      cookies,
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/members`,
      ),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workspace_id: string;
      members: Array<{
        user_id: string;
        email: string | null;
        display_name: string | null;
        role: string;
      }>;
    };
    expect(body.workspace_id).toBe(workspace.id);
    expect(body.members.length).toBe(2);
    const byEmail = new Map(body.members.map((m) => [m.email, m]));
    expect(byEmail.get(admin.email)?.role).toBe("admin");
    expect(byEmail.get(admin.email)?.display_name).toBe(admin.displayName);
    expect(byEmail.get(second.email)?.role).toBe("reader");
  });

  it("returns 400 when workspace_id route param is missing", async () => {
    const response = await getMembers({
      cookies: sessionCookies("ses_test"),
      params: {},
      request: new Request(
        "https://pages.example.test/api/workspaces//members",
      ),
    } as never);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("WORKSPACE_REQUIRED");
  });

  it("rejects non-members with 403 — emails do not leak across workspaces", async () => {
    // Audit cycle 4: the original version of this route shipped without
    // any permission check, letting any authenticated user enumerate
    // every workspace's member emails. This regression test pins that.
    const { workspace } = await fixture();
    const { ctx: outsiderCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const outsider = await users.upsert(outsiderCtx, {
      id: uniqueId("usr"),
      email: `members-outsider-${crypto.randomUUID()}@example.test`,
      displayName: "Outsider",
      role: "user",
    });
    const session = await auth.createSession(outsiderCtx, {
      userId: outsider.id,
    });
    const response = await getMembers({
      cookies: sessionCookies(session.id),
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/members`,
      ),
    } as never);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("PERMISSION_DENIED");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { workspace } = await fixture();
    const response = await getMembers({
      cookies: { get: () => undefined } as never,
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/members`,
      ),
    } as never);
    // Unauthenticated → either 401 (auth required) or 403 (permission
    // denied), depending on the access layer's preference. Either is
    // acceptable; the contract is "no leak".
    expect([401, 403]).toContain(response.status);
  });
});
