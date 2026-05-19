import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  pages as pagesService,
  publications as publicationsService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import {
  getApiRequestActor,
  getRequestActor,
  resolveActorPermission,
  resolvePageAccess,
} from "./access";
import { createMcpSession } from "./runtime";
import { buildServiceContext } from "./service-context";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-access-test-"));
});

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

async function seedCtx() {
  const { ctx } = await buildServiceContext({ cookies: emptyCookies() });
  return ctx;
}

afterEach(() => {
  delete process.env.VPG_DEV_AUTO_LOGIN;
});

describe("resolvePageAccess", () => {
  it("does not use the demo admin fallback unless runtime env opts in", async () => {
    const ctx = await seedCtx();
    const demo = await users.upsert(ctx, {
      id: "usr_demo_admin",
      email: `demo-admin-${crypto.randomUUID()}@example.com`,
      displayName: "Demo Admin",
      role: "instance_admin",
    });

    expect(await getRequestActor(emptyCookies())).toMatchObject({
      user: null,
      devFallback: false,
    });

    process.env.VPG_DEV_AUTO_LOGIN = "true";
    expect(await getRequestActor(emptyCookies())).toMatchObject({
      user: expect.objectContaining({ id: demo.id, email: demo.email }),
      devFallback: true,
    });
  });

  it("applies public page publications without a token", async () => {
    const ctx = await seedCtx();
    const owner = await users.upsert(ctx, {
      id: uniqueId("usr"),
      email: `owner-${crypto.randomUUID()}@example.com`,
      displayName: "Workspace Owner",
      role: "user",
    });
    const workspace = await workspaces.create(ctx, {
      id: uniqueId("wks"),
      name: "Share Token Test",
      slug: uniqueId("slug"),
      firstAdminUserId: owner.id,
    });
    // Page creation requires an authenticated actor; build a
    // workspace-scoped ctx for the owner.
    const { ctx: ownerCtx } = await buildServiceContext({
      cookies: emptyCookies(),
      workspaceId: workspace.id,
    });
    ownerCtx.actor.userId = owner.id;
    ownerCtx.actor.email = owner.email;
    const created = await pagesService.create(ownerCtx, {
      workspaceId: workspace.id,
      folderPath: "",
      title: "Token gated page",
      sourceType: "markdown",
      source: "# Token gated page",
    });
    const page = created.data;
    const outsider = await users.upsert(ctx, {
      id: uniqueId("usr"),
      email: `outsider-${crypto.randomUUID()}@example.com`,
      displayName: "Outsider",
      role: "user",
    });
    const session = await auth.createSession(ctx, { userId: outsider.id });
    const publication = await publicationsService.upsert(ownerCtx, {
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
    const ctx = await seedCtx();
    const user = await users.upsert(ctx, {
      id: uniqueId("usr"),
      email: `bearer-${crypto.randomUUID()}@example.com`,
      displayName: "Bearer User",
      role: "user",
    });
    const first = await workspaces.create(ctx, {
      id: uniqueId("wks"),
      name: "Bearer First",
      slug: uniqueId("slug"),
      firstAdminUserId: user.id,
    });
    const second = await workspaces.create(ctx, {
      id: uniqueId("wks"),
      name: "Bearer Second",
      slug: uniqueId("slug"),
      firstAdminUserId: user.id,
    });
    const { ctx: secondOwnerCtx } = await buildServiceContext({
      cookies: emptyCookies(),
      workspaceId: second.id,
    });
    secondOwnerCtx.actor.userId = user.id;
    secondOwnerCtx.actor.email = user.email;
    const created = await pagesService.create(secondOwnerCtx, {
      workspaceId: second.id,
      folderPath: "",
      title: "Scoped",
      sourceType: "markdown",
      source: "# Scoped",
    });
    const page = created.data;
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
    expect(await resolveActorPermission({ actor, page: page.page })).toBe(
      "none",
    );
  });
});
