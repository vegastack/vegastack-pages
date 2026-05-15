import { describe, expect, it } from "vitest";
import { GET as getTree } from "../[workspaceId]/tree";
import {
  authService,
  pageService,
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

async function fixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Tree ${crypto.randomUUID()}`,
  });
  const admin = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `tree-admin-${crypto.randomUUID()}@example.test`,
    displayName: "Tree Admin",
    role: "user",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: admin.id,
    role: "admin",
  });
  const docs = workspaceService.createFolder({
    id: uniqueId("fld"),
    workspaceId: workspace.id,
    name: "Docs",
  });
  const nested = workspaceService.createFolder({
    id: uniqueId("fld"),
    workspaceId: workspace.id,
    parentFolderId: docs.id,
    name: "Nested",
  });
  await pageService.createPage({
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: docs.path,
    title: "Docs Page",
    sourceType: "markdown",
    source: "# Docs Page",
  });
  await pageService.createPage({
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: nested.path,
    title: "Nested Page",
    sourceType: "markdown",
    source: "# Nested Page",
  });
  return { workspace, admin, docs, nested };
}

describe("workspace tree API", () => {
  it("rejects inaccessible or invalid folder filters instead of returning the full tree", async () => {
    const { workspace, admin } = await fixture();
    const response = await getTree({
      cookies: sessionCookies(authService.createSession(admin.id).id),
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree?workspace_id=${workspace.id}&folder_id=fld_missing`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree?workspace_id=${workspace.id}&folder_id=fld_missing`,
      ),
    } as never);

    expect(response.status).toBe(404);
  });

  it("applies root depth filters and marks partial responses", async () => {
    const { workspace, admin, nested } = await fixture();
    const response = await getTree({
      cookies: sessionCookies(authService.createSession(admin.id).id),
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree?workspace_id=${workspace.id}&depth=1&include_counts=true`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree?workspace_id=${workspace.id}&depth=1&include_counts=true`,
      ),
    } as never);
    const body = (await response.json()) as {
      folders: Array<{ id: string }>;
      partial: boolean;
      favorite_page_ids: string[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.partial).toBe(true);
    expect(body.favorite_page_ids).toEqual([]);
    expect(body.folders.some((folder) => folder.id === nested.id)).toBe(false);
  });
});
