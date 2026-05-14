import { afterEach, describe, expect, it } from "vitest";
import {
  getApiRequestActor,
  getRequestActor,
  resolveActorPermission,
  resolvePageAccess,
} from "./access";
import {
  authService,
  createMcpSession,
  pageService,
  publicationService,
  workspaceService,
} from "./runtime";

function sessionCookies(sessionId: string) {
  return {
    get(name: string) {
      return name === "vpg_session" ? { value: sessionId } : undefined;
    },
  } as never;
}

function emptyCookies() {
  return {
    get() {
      return undefined;
    },
  } as never;
}

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

afterEach(() => {
  delete process.env.VPG_DEV_AUTO_LOGIN;
});

describe("resolvePageAccess", () => {
  it("does not use the demo admin fallback unless runtime env opts in", () => {
    const demo = workspaceService.createUser({
      id: "usr_demo_admin",
      email: `demo-admin-${crypto.randomUUID()}@example.com`,
      displayName: "Demo Admin",
      role: "instance_admin",
    });

    expect(getRequestActor(emptyCookies())).toMatchObject({
      user: null,
      devFallback: false,
    });

    process.env.VPG_DEV_AUTO_LOGIN = "true";
    expect(getRequestActor(emptyCookies())).toMatchObject({
      user: demo,
      devFallback: true,
    });
  });

  it("applies public page publications without a token", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Share Token Test",
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Token gated page",
      sourceType: "markdown",
      source: "# Token gated page",
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `outsider-${crypto.randomUUID()}@example.com`,
      displayName: "Outsider",
      role: "user",
    });
    const session = authService.createSession(user.id);
    const publication = await publicationService.upsert({
      resourceType: "page",
      resourceId: page.page.id,
      workspaceId: workspace.id,
      permission: "view",
    });

    const access = await resolvePageAccess({
      cookies: sessionCookies(session.id),
      url: new URL(`https://pages.example.test/p/${page.page.slugId}`),
      page: page.page,
      required: "read",
    });

    expect(access.permission).toBe("read");
    expect(access.publicationId).toBe(publication.id);
  });

  it("scopes bearer MCP sessions to their workspace", async () => {
    const first = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Bearer First",
    });
    const second = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Bearer Second",
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `bearer-${crypto.randomUUID()}@example.com`,
      displayName: "Bearer User",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: first.id,
      userId: user.id,
      role: "admin",
    });
    workspaceService.addMember({
      workspaceId: second.id,
      userId: user.id,
      role: "admin",
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: second.id,
      folderPath: "",
      title: "Scoped",
      sourceType: "markdown",
      source: "# Scoped",
    });
    const session = await createMcpSession({
      workspaceId: first.id,
      userId: user.id,
      clientName: "test",
      protocolVersion: null,
    });
    const actor = await getApiRequestActor(
      emptyCookies(),
      new Request("https://pages.example.test/api/pages", {
        headers: { authorization: `Bearer ${session.rawToken}` },
      }),
    );

    expect(actor.workspaceId).toBe(first.id);
    expect(resolveActorPermission({ actor, page: page.page })).toBe("none");
  });
});
