import { describe, expect, it } from "vitest";
import {
  authService,
  favoriteService,
  pageService,
  workspaceService,
} from "../../../../lib/runtime";
import { DELETE, PUT } from "../[pageId]/favorite";
import { GET as listFavorites } from "../../workspaces/[workspaceId]/favorites";

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

describe("page favorite API", () => {
  it("adds, lists, and removes user-scoped favorites", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Favorites ${crypto.randomUUID()}`,
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `favorite-${crypto.randomUUID()}@example.test`,
      displayName: "Favorite User",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: "reader",
    });
    const session = authService.createSession(user.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      title: "Favorite page",
      sourceType: "markdown",
      source: "# Favorite page",
    });

    const putResponse = await PUT({
      cookies: sessionCookies(session.id),
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/favorite?workspace_id=${workspace.id}`,
        { method: "PUT" },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.page.id}/favorite?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(putResponse.status).toBe(200);
    expect(favoriteService.isFavorite(user.id, page.page.id)).toBe(true);

    const listResponse = await listFavorites({
      cookies: sessionCookies(session.id),
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
        page_id: page.page.id,
        title: "Favorite page",
      }),
    ]);

    const deleteResponse = await DELETE({
      cookies: sessionCookies(session.id),
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/favorite?workspace_id=${workspace.id}`,
        { method: "DELETE" },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.page.id}/favorite?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(deleteResponse.status).toBe(200);
    expect(favoriteService.isFavorite(user.id, page.page.id)).toBe(false);
  });

  it("requires read permission to favorite a page", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Private favorites ${crypto.randomUUID()}`,
    });
    const outsider = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `favorite-outsider-${crypto.randomUUID()}@example.test`,
      displayName: "Favorite Outsider",
    });
    const session = authService.createSession(outsider.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      title: "Private favorite page",
      sourceType: "markdown",
      source: "# Private favorite page",
    });

    const response = await PUT({
      cookies: sessionCookies(session.id),
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/favorite?workspace_id=${workspace.id}`,
        { method: "PUT" },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.page.id}/favorite?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(403);
    expect(favoriteService.isFavorite(outsider.id, page.page.id)).toBe(false);
  });
});
