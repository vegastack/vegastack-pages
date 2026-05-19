import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  pages as pagesService,
  publications,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { POST as movePage } from "../[pageId]/move";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-page-move-"));
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

describe("page move API", () => {
  it("rejects moves into folder paths that do not exist in the workspace", async () => {
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const user = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `move-folder-${crypto.randomUUID()}@example.test`,
      displayName: "Move Folder Admin",
      role: "user",
    });
    const workspace = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: `Move Folder ${crypto.randomUUID()}`,
      slug: uniqueId("slug"),
      firstAdminUserId: user.id,
    });
    const session = await auth.createSession(seedCtx, { userId: user.id });
    const { ctx: actorCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    actorCtx.actor.userId = user.id;
    actorCtx.actor.email = user.email;
    const created = await pagesService.create(actorCtx, {
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Original title",
      sourceType: "markdown",
      source: "# Original title",
    });
    const page = created.data.page;

    const response = await movePage({
      cookies: sessionCookies(session.id),
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/move?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ folder_path: "missing/folder" }),
        },
      ),
      url: new URL(`https://pages.example.test/p/${page.slugId}`),
    } as never);
    const current = await pagesService.get(actorCtx, page.id);
    const body = (await response.json()) as {
      error?: { code?: string };
    };

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("FOLDER_NOT_FOUND");
    expect(current?.page.folderPath).toBe("");
  });

  it("does not let public edit guests rename or move pages", async () => {
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const owner = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `move-share-${crypto.randomUUID()}@example.test`,
      displayName: "Move Share Owner",
      role: "user",
    });
    const workspace = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: `Move Share ${crypto.randomUUID()}`,
      slug: uniqueId("slug"),
      firstAdminUserId: owner.id,
    });
    const { ctx: ownerCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    ownerCtx.actor.userId = owner.id;
    ownerCtx.actor.email = owner.email;
    const created = await pagesService.create(ownerCtx, {
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Original title",
      sourceType: "markdown",
      source: "# Original title",
    });
    const page = created.data.page;
    await publications.upsert(ownerCtx, {
      resourceType: "page",
      resourceId: page.id,
      workspaceId: workspace.id,
      permission: "edit",
    });

    const response = await movePage({
      cookies: { get: () => undefined },
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/move?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Moved by guest",
            folder_path: "private",
            guest_name: "Guest Editor",
          }),
        },
      ),
      url: new URL(`https://pages.example.test/p/${page.slugId}`),
    } as never);
    const current = await pagesService.get(ownerCtx, page.id);

    expect(response.status).toBe(403);
    expect(current?.page.title).toBe("Original title");
    expect(current?.page.folderPath).toBe("");
  });
});
