import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DELETE as deleteFolderAccess,
  GET as getFolderAccess,
  POST as setFolderAccess,
} from "../../folders/[folderId]/access";
import { GET as searchWorkspaces } from "../../search";
import { POST as setPageAccess } from "../../pages/[pageId]/access";
import { GET as getTree } from "../[workspaceId]/tree";
import {
  auth,
  folders as foldersService,
  pages as pagesService,
  permissions as permissionsService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { indexPage } from "../../../../lib/runtime";
import {
  canReadFolderOrVisibleDescendants,
  listVisibleFoldersForActor,
} from "../../../../lib/workspace-visibility";
import { getRequestActor } from "../../../../lib/access";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-grants-test-"));
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

    const { ctx: outsiderCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const outsider = await users.upsert(outsiderCtx, {
      id: uniqueId("usr"),
      email: `resource-outsider-${crypto.randomUUID()}@example.com`,
      displayName: "Resource Outsider",
      role: "user",
    });
    const rejected = await grantPageAccess(ownerCookies, page.page.id, {
      subject_id: outsider.id,
      level: "read",
    });
    expect(rejected.status).toBe(400);

    const { ctx: listCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const pageGrants = (
      await permissionsService.listGrants(listCtx, {
        workspaceId: workspace.id,
        targetId: page.page.id,
      })
    ).filter((grant) => grant.scope === "page");
    expect(pageGrants).toHaveLength(1);
  });

  it("applies folder no-access grants to tree, search, and folder visibility", async () => {
    const { ownerCookies, targetCookies, workspace, target, folder, page } =
      await createWorkspaceFixture();

    await grantFolderAccess(ownerCookies, folder.id, {
      subject_id: target.id,
      level: "none",
    });
    // Re-index the page from D1 so the FTS table has the "needle" body
    // text the assertions below search for. The fixture already created
    // the page with body content containing "needle"; this just ensures
    // the search index is up to date before the access-grant changes.
    await indexPage(page.page.id);

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

    const actor = await getRequestActor(targetCookies);
    expect(await canReadFolderOrVisibleDescendants(actor, folder.id)).toBe(
      false,
    );
    const visibleFolders = await listVisibleFoldersForActor(
      actor,
      workspace.id,
    );
    expect(visibleFolders.map((item) => item.id)).not.toContain(folder.id);
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

    const actor = await getRequestActor(targetCookies);
    expect(await canReadFolderOrVisibleDescendants(actor, folder.id)).toBe(
      true,
    );
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
    const { ctx: listCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const folderGrants = (
      await permissionsService.listGrants(listCtx, {
        workspaceId: folder.workspaceId,
        targetId: folder.id,
      })
    ).filter((grant) => grant.scope === "folder");
    expect(folderGrants).toHaveLength(0);
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
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const owner = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `resource-owner-${crypto.randomUUID()}@example.com`,
    displayName: "Resource Owner",
    role: "user",
  });
  const target = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `resource-target-${crypto.randomUUID()}@example.com`,
    displayName: "Resource Target",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Resource Access Workspace ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: owner.id,
  });
  await workspaces.addMember(seedCtx, {
    workspaceId: workspace.id,
    userId: target.id,
    role: "editor",
  });
  // Folder + page creation flow through the D1-direct services using a
  // workspace-scoped ctx so they're persisted to D1 immediately.
  const { ctx: ownerCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    workspaceId: workspace.id,
  });
  ownerCtx.actor.userId = owner.id;
  ownerCtx.actor.email = owner.email;
  const folder = await foldersService.create(ownerCtx, {
    workspaceId: workspace.id,
    parentFolderId: null,
    name: "Private Guides",
  });
  const created = await pagesService.create(ownerCtx, {
    workspaceId: workspace.id,
    folderPath: folder.path,
    title: "Scoped Grant Page",
    sourceType: "markdown",
    source: "# Private scoped heading\n\nneedle private content",
  });
  const page = created.data;
  const ownerSession = await auth.createSession(seedCtx, { userId: owner.id });
  const targetSession = await auth.createSession(seedCtx, {
    userId: target.id,
  });

  return {
    workspace,
    owner,
    target,
    folder,
    page,
    ownerCookies: sessionCookies(ownerSession.id),
    targetCookies: sessionCookies(targetSession.id),
  };
}

async function grantPageAccess(
  cookies: ReturnType<typeof sessionCookies>,
  pageId: string,
  body: Record<string, unknown>,
) {
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const page = await pagesService.get(ctx, pageId);
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

async function grantFolderAccess(
  cookies: ReturnType<typeof sessionCookies>,
  folderId: string,
  body: Record<string, unknown>,
) {
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const folder = await foldersService.get(ctx, folderId);
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
