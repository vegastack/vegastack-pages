import { describe, expect, it } from "vitest";
import {
  authService,
  pageService,
  publicationService,
  workspaceService,
} from "../../../../lib/runtime";
import { POST as movePage } from "../[pageId]/move";

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
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Move Folder ${crypto.randomUUID()}`,
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `move-folder-${crypto.randomUUID()}@example.test`,
      displayName: "Move Folder Admin",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: "admin",
    });
    const session = authService.createSession(user.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Original title",
      sourceType: "markdown",
      source: "# Original title",
    });

    const response = await movePage({
      cookies: sessionCookies(session.id),
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/move?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ folder_path: "missing/folder" }),
        },
      ),
      url: new URL(`https://pages.example.test/p/${page.page.slugId}`),
    } as never);
    const current = await pageService.getPage(page.page.id);
    const body = (await response.json()) as {
      error?: { code?: string };
    };

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("FOLDER_NOT_FOUND");
    expect(current?.page.folderPath).toBe("");
  });

  it("does not let public edit guests rename or move pages", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Move Share ${crypto.randomUUID()}`,
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Original title",
      sourceType: "markdown",
      source: "# Original title",
    });
    await publicationService.upsert({
      resourceType: "page",
      resourceId: page.page.id,
      workspaceId: workspace.id,
      permission: "edit",
    });

    const response = await movePage({
      cookies: { get: () => undefined },
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/move?workspace_id=${workspace.id}`,
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
      url: new URL(`https://pages.example.test/p/${page.page.slugId}`),
    } as never);
    const current = await pageService.getPage(page.page.id);

    expect(response.status).toBe(403);
    expect(current?.page.title).toBe("Original title");
    expect(current?.page.folderPath).toBe("");
  });
});
