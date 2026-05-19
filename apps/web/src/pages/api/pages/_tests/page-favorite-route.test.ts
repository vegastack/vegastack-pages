import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { auth, pages, users, workspaces } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { DELETE, PUT } from "../[pageId]/favorite";
import { GET as listFavorites } from "../../workspaces/[workspaceId]/favorites";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-fav-"));
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

function emptySeedCookies() {
  return { get: () => undefined } as never;
}

type SeedOptions = {
  workspaceName: string;
  pageTitle: string;
  pageSource: string;
  role?: "admin" | "editor" | "commenter" | "reader" | null;
  email?: string;
  displayName?: string;
};

async function seedWorkspaceAndPage(options: SeedOptions) {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: emptySeedCookies(),
  });

  const user = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: options.email ?? `seed-${crypto.randomUUID()}@example.test`,
    displayName: options.displayName ?? "Seed User",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: options.workspaceName,
    slug: uniqueId("slug"),
    firstAdminUserId: options.role ? user.id : undefined,
  });
  if (options.role && options.role !== "admin") {
    await workspaces.addMember(seedCtx, {
      workspaceId: workspace.id,
      userId: user.id,
      role: options.role,
    });
  }
  const session = await auth.createSession(seedCtx, { userId: user.id });

  const { ctx: actorCtx } = await buildServiceContext({
    cookies: sessionCookies(session.id),
    workspaceId: workspace.id,
  });
  const created = await pages.create(actorCtx, {
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: "",
    title: options.pageTitle,
    sourceType: "markdown",
    source: options.pageSource,
  });

  // Sync legacy in-memory caches that routes still consult for
  // page/member/session lookups.

  return {
    user,
    workspace,
    session,
    page: created.data.page,
    cookies: sessionCookies(session.id),
    seedCtx,
  };
}

async function favoriteRowCount(
  seedCtx: Awaited<ReturnType<typeof buildServiceContext>>["ctx"],
  userId: string,
  pageId: string,
) {
  const row = await seedCtx
    .db!.prepare(
      "SELECT COUNT(*) AS n FROM page_favorites WHERE user_id = ?1 AND page_id = ?2",
    )
    .bind(userId, pageId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe("page favorite API", () => {
  it("adds, lists, and removes user-scoped favorites", async () => {
    const { user, workspace, page, cookies, seedCtx } =
      await seedWorkspaceAndPage({
        workspaceName: `Favorites ${crypto.randomUUID()}`,
        pageTitle: "Favorite page",
        pageSource: "# Favorite page",
        role: "reader",
      });

    const putResponse = await PUT({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/favorite?workspace_id=${workspace.id}`,
        { method: "PUT" },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}/favorite?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(putResponse.status).toBe(200);
    expect(await favoriteRowCount(seedCtx, user.id, page.id)).toBe(1);

    // Sync the new D1 favorite into the legacy in-memory cache the
    // listing route consults.

    const listResponse = await listFavorites({
      cookies,
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/favorites`,
      ),
    } as never);
    const listBody = (await listResponse.json()) as {
      favorites?: Array<{ page_id: string; title: string }>;
    };

    expect(listResponse.status).toBe(200);
    expect(listBody.favorites).toEqual([
      expect.objectContaining({
        page_id: page.id,
        title: "Favorite page",
      }),
    ]);

    const deleteResponse = await DELETE({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/favorite?workspace_id=${workspace.id}`,
        { method: "DELETE" },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}/favorite?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(deleteResponse.status).toBe(200);
    expect(await favoriteRowCount(seedCtx, user.id, page.id)).toBe(0);
  });

  it("requires read permission to favorite a page", async () => {
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: emptySeedCookies(),
    });

    // Workspace owner (not the outsider) is the page creator.
    const owner = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `favorite-owner-${crypto.randomUUID()}@example.test`,
      displayName: "Favorite Owner",
    });
    const workspace = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: `Private favorites ${crypto.randomUUID()}`,
      slug: uniqueId("slug"),
      firstAdminUserId: owner.id,
    });

    const outsider = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `favorite-outsider-${crypto.randomUUID()}@example.test`,
      displayName: "Favorite Outsider",
    });
    const outsiderSession = await auth.createSession(seedCtx, {
      userId: outsider.id,
    });

    // Build a creator context so pages.create stamps created_by with
    // the workspace owner.
    const ownerSession = await auth.createSession(seedCtx, {
      userId: owner.id,
    });
    const { ctx: ownerCtx } = await buildServiceContext({
      cookies: sessionCookies(ownerSession.id),
      workspaceId: workspace.id,
    });
    const created = await pages.create(ownerCtx, {
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Private favorite page",
      sourceType: "markdown",
      source: "# Private favorite page",
    });

    const response = await PUT({
      cookies: sessionCookies(outsiderSession.id),
      params: { pageId: created.data.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${created.data.page.id}/favorite?workspace_id=${workspace.id}`,
        { method: "PUT" },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${created.data.page.id}/favorite?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(403);
    expect(
      await favoriteRowCount(seedCtx, outsider.id, created.data.page.id),
    ).toBe(0);
  });
});
