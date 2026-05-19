import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as getTree } from "../[workspaceId]/tree";
import {
  auth,
  folders as foldersService,
  pages as pagesService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-tree-test-"));
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
    email: `tree-admin-${crypto.randomUUID()}@example.test`,
    displayName: "Tree Admin",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Tree ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: admin.id,
  });
  // Workspace-scoped ctx authenticated as the admin owner so the
  // folder/page services accept the writes.
  const { ctx: adminCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    workspaceId: workspace.id,
  });
  adminCtx.actor.userId = admin.id;
  adminCtx.actor.email = admin.email;
  const docs = await foldersService.create(adminCtx, {
    workspaceId: workspace.id,
    parentFolderId: null,
    name: "Docs",
  });
  const nested = await foldersService.create(adminCtx, {
    workspaceId: workspace.id,
    parentFolderId: docs.id,
    name: "Nested",
  });
  await pagesService.create(adminCtx, {
    workspaceId: workspace.id,
    folderPath: docs.path,
    title: "Docs Page",
    sourceType: "markdown",
    source: "# Docs Page",
  });
  await pagesService.create(adminCtx, {
    workspaceId: workspace.id,
    folderPath: nested.path,
    title: "Nested Page",
    sourceType: "markdown",
    source: "# Nested Page",
  });
  // Mirror D1 rows into legacy in-memory so the tree route's legacy
  // membership/folder reads see the same fixture state.
  return { workspace, admin, docs, nested };
}

describe("workspace tree API", () => {
  it("rejects inaccessible or invalid folder filters instead of returning the full tree", async () => {
    const { workspace, admin } = await fixture();
    const { ctx: sessionCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const session = await auth.createSession(sessionCtx, { userId: admin.id });
    const cookies = sessionCookies(session.id);
    const response = await getTree({
      cookies,
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
    const { ctx: sessionCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const session = await auth.createSession(sessionCtx, { userId: admin.id });
    const cookies = sessionCookies(session.id);
    const response = await getTree({
      cookies,
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

  it("rejects non-members with 403 — `canReadWorkspaceOrScopedPages` is awaited", async () => {
    // Audit cycle 5 regression: previously the visibility check was a
    // missing-await Promise, which is truthy → permission gate never
    // blocked. This test pins the post-fix behavior so the await can't
    // silently regress.
    const { workspace } = await fixture();
    const { ctx: outsiderCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const outsider = await users.upsert(outsiderCtx, {
      id: uniqueId("usr"),
      email: `tree-outsider-${crypto.randomUUID()}@example.test`,
      displayName: "Outsider",
      role: "user",
    });
    const session = await auth.createSession(outsiderCtx, {
      userId: outsider.id,
    });
    const cookies = sessionCookies(session.id);
    const response = await getTree({
      cookies,
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/tree?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(403);
  });
});
