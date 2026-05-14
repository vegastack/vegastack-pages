import { describe, expect, it } from "vitest";
import {
  DELETE as deleteFolderAccess,
  GET as getFolderAccess,
  POST as setFolderAccess,
} from "../../folders/[folderId]/access";
import { GET as searchWorkspaces } from "../../search";
import { POST as setPageAccess } from "../../pages/[pageId]/access";
import { GET as getTree } from "../[workspaceId]/tree";
import {
  authService,
  pageService,
  permissionService,
  searchService,
  workspaceService,
} from "../../../../lib/runtime";
import {
  canReadFolderOrVisibleDescendants,
  listVisibleFoldersForActor,
} from "../../../../lib/workspace-visibility";
import { getRequestActor } from "../../../../lib/access";

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

function resourceUrl(path: string, workspaceId: string) {
  return `https://pages.example.test${path}?workspace_id=${encodeURIComponent(workspaceId)}`;
}

describe("resource member access", () => {
  it("requires search callers to provide an explicit workspace id", async () => {
    const response = await searchWorkspaces({
      cookies: sessionCookies("ses_missing"),
      url: new URL("https://pages.example.test/api/search?q=needle"),
    } as never);
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("WORKSPACE_REQUIRED");
    expect(body.error?.message).toBe(
      "workspace_id is required for this API request.",
    );
  });

  it("sets page access for workspace members only", async () => {
    const { ownerCookies, workspace, target, page } =
      await createWorkspaceFixture();

    const response = await grantPageAccess(ownerCookies, page.page.id, {
      subject_id: target.id,
      level: "comment",
    });
    const body = (await response.json()) as {
      grant: { scope: string; target_id: string; level: string };
    };

    expect(response.status).toBe(200);
    expect(body.grant).toMatchObject({
      scope: "page",
      target_id: page.page.id,
      level: "comment",
    });

    const outsider = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `resource-outsider-${crypto.randomUUID()}@example.com`,
      displayName: "Resource Outsider",
    });
    const rejected = await grantPageAccess(ownerCookies, page.page.id, {
      subject_id: outsider.id,
      level: "read",
    });
    expect(rejected.status).toBe(400);

    expect(
      permissionService.listGrants({
        workspaceId: workspace.id,
        scope: "page",
        targetId: page.page.id,
      }),
    ).toHaveLength(1);
  });

  it("applies folder no-access grants to tree, search, and folder visibility", async () => {
    const { ownerCookies, targetCookies, workspace, target, folder, page } =
      await createWorkspaceFixture();

    await grantFolderAccess(ownerCookies, folder.id, {
      subject_id: target.id,
      level: "none",
    });
    searchService.index({
      id: page.page.id,
      type: "page",
      pageId: page.page.id,
      workspaceId: workspace.id,
      title: page.page.title,
      path: page.page.folderPath,
      headingsText: "Private scoped heading",
      frontmatterText: "",
      bodyText: "needle private content",
      tags: "",
      url: `/p/${page.page.slugId}`,
      updatedAt: page.page.updatedAt,
    });

    const treeResponse = await getTree({
      cookies: targetCookies,
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree`,
      ),
    } as never);
    const tree = (await treeResponse.json()) as {
      pages?: Array<{ id: string }>;
      folders?: Array<{ id: string }>;
    };

    expect(treeResponse.status).toBe(200);
    expect(tree.pages?.map((item) => item.id)).not.toContain(page.page.id);
    expect(tree.folders?.map((item) => item.id)).not.toContain(folder.id);

    const searchResponse = await searchWorkspaces({
      cookies: targetCookies,
      request: new Request("https://pages.example.test/api/search"),
      url: new URL(
        `https://pages.example.test/api/search?workspace_id=${workspace.id}&q=needle`,
      ),
    } as never);
    const searchBody = (await searchResponse.json()) as {
      results: Array<{ pageId: string }>;
    };
    expect(searchBody.results.map((item) => item.pageId)).not.toContain(
      page.page.id,
    );

    const actor = getRequestActor(targetCookies);
    expect(canReadFolderOrVisibleDescendants(actor, folder.id)).toBe(false);
    expect(
      listVisibleFoldersForActor(actor, workspace.id).map((item) => item.id),
    ).not.toContain(folder.id);
  });

  it("lets a page grant re-expose one child page inside a denied folder", async () => {
    const { ownerCookies, targetCookies, workspace, target, folder, page } =
      await createWorkspaceFixture();

    await grantFolderAccess(ownerCookies, folder.id, {
      subject_id: target.id,
      level: "none",
    });
    await grantPageAccess(ownerCookies, page.page.id, {
      subject_id: target.id,
      level: "read",
    });

    const treeResponse = await getTree({
      cookies: targetCookies,
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree`,
      ),
    } as never);
    const tree = (await treeResponse.json()) as {
      pages?: Array<{ id: string }>;
      folders?: Array<{ id: string }>;
    };

    expect(treeResponse.status).toBe(200);
    expect(tree.pages?.map((item) => item.id)).toContain(page.page.id);
    expect(tree.folders?.map((item) => item.id)).toContain(folder.id);

    const actor = getRequestActor(targetCookies);
    expect(canReadFolderOrVisibleDescendants(actor, folder.id)).toBe(true);
  });

  it("lists and removes folder access rules through the folder resource API", async () => {
    const { ownerCookies, workspace, target, folder } =
      await createWorkspaceFixture();

    const create = await grantFolderAccess(ownerCookies, folder.id, {
      subject_id: target.id,
      level: "write",
    });
    const created = (await create.json()) as { grant: { id: string } };

    const list = await getFolderAccess({
      cookies: ownerCookies,
      params: { folderId: folder.id },
      request: new Request(
        resourceUrl(`/api/folders/${folder.id}/access`, workspace.id),
      ),
    } as never);
    const body = (await list.json()) as {
      grants: Array<{ id: string; level: string }>;
    };

    expect(body.grants).toContainEqual(
      expect.objectContaining({ id: created.grant.id, level: "write" }),
    );

    const remove = await deleteFolderAccess({
      cookies: ownerCookies,
      params: { folderId: folder.id },
      request: new Request(
        resourceUrl(`/api/folders/${folder.id}/access`, workspace.id),
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_id: created.grant.id }),
        },
      ),
    } as never);

    expect(remove.status).toBe(200);
    expect(
      permissionService.listGrants({
        workspaceId: folder.workspaceId,
        scope: "folder",
        targetId: folder.id,
      }),
    ).toHaveLength(0);
  });

  it("rejects self access changes from the share dialog API", async () => {
    const { ownerCookies, owner, page } = await createWorkspaceFixture();

    const response = await grantPageAccess(ownerCookies, page.page.id, {
      subject_id: owner.id,
      level: "none",
    });

    expect(response.status).toBe(400);
  });
});

async function createWorkspaceFixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Resource Access Workspace ${crypto.randomUUID()}`,
  });
  const owner = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `resource-owner-${crypto.randomUUID()}@example.com`,
    displayName: "Resource Owner",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: owner.id,
    role: "admin",
  });
  const target = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `resource-target-${crypto.randomUUID()}@example.com`,
    displayName: "Resource Target",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: target.id,
    role: "editor",
  });
  const folder = workspaceService.createFolder({
    id: uniqueId("fld"),
    workspaceId: workspace.id,
    name: "Private Guides",
  });
  const page = await pageService.createPage({
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: folder.path,
    title: "Scoped Grant Page",
    sourceType: "markdown",
    source: "# Private scoped heading\n\nneedle private content",
  });

  return {
    workspace,
    owner,
    target,
    folder,
    page,
    ownerCookies: sessionCookies(authService.createSession(owner.id).id),
    targetCookies: sessionCookies(authService.createSession(target.id).id),
  };
}

async function grantPageAccess(
  cookies: ReturnType<typeof sessionCookies>,
  pageId: string,
  body: Record<string, unknown>,
) {
  const page = await pageService.getPage(pageId);
  if (!page) {
    throw new Error(`Missing test page ${pageId}`);
  }
  return setPageAccess({
    cookies,
    params: { pageId },
    request: new Request(
      resourceUrl(`/api/pages/${pageId}/access`, page.page.workspaceId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  } as never);
}

function grantFolderAccess(
  cookies: ReturnType<typeof sessionCookies>,
  folderId: string,
  body: Record<string, unknown>,
) {
  const folder = workspaceService.getFolder(folderId);
  if (!folder) {
    throw new Error(`Missing test folder ${folderId}`);
  }
  return setFolderAccess({
    cookies,
    params: { folderId },
    request: new Request(
      resourceUrl(`/api/folders/${folderId}/access`, folder.workspaceId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  } as never);
}
