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
import { GET as getPage } from "../[pageId]";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-page-ref-"));
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

function apiRequest(path: string) {
  return new Request(`https://pages.example.test${path}`);
}

async function fixture() {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const admin = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `page-admin-${crypto.randomUUID()}@example.test`,
    displayName: "Page Admin",
    role: "user",
  });
  const reader = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `page-reader-${crypto.randomUUID()}@example.test`,
    displayName: "Page Reader",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Page Ref ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: admin.id,
  });
  await workspaces.addMember(seedCtx, {
    workspaceId: workspace.id,
    userId: reader.id,
    role: "reader",
  });
  const { ctx: adminCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    workspaceId: workspace.id,
  });
  adminCtx.actor.userId = admin.id;
  adminCtx.actor.email = admin.email;
  const created = await pagesService.create(adminCtx, {
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: "",
    title: "Published internals",
    sourceType: "markdown",
    source: "# Published internals",
  });
  const page = created.data.page;
  await publications.upsert(adminCtx, {
    workspaceId: workspace.id,
    resourceType: "page",
    resourceId: page.id,
    permission: "comment",
    password: "review-secret",
    indexingEnabled: true,
  });
  return { workspace, admin, reader, page, seedCtx };
}

describe("page ref API", () => {
  it("requires admin access before returning publication internals", async () => {
    const { workspace, reader, page, seedCtx } = await fixture();
    const readerSession = await auth.createSession(seedCtx, {
      userId: reader.id,
    });
    const readerCookies = sessionCookies(readerSession.id);
    const response = await getPage({
      cookies: readerCookies,
      params: { pageId: page.id },
      request: apiRequest(
        `/api/pages/${page.id}?workspace_id=${workspace.id}&include=publication`,
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}?workspace_id=${workspace.id}&include=publication`,
      ),
    } as never);

    expect(response.status).toBe(403);
  });

  it("returns bounded private page includes for admins", async () => {
    const { workspace, admin, page, seedCtx } = await fixture();
    const adminSession = await auth.createSession(seedCtx, {
      userId: admin.id,
    });
    const adminCookies = sessionCookies(adminSession.id);
    const response = await getPage({
      cookies: adminCookies,
      params: { pageId: page.slugId },
      request: apiRequest(
        `/api/pages/${page.slugId}?workspace_id=${workspace.id}&include=source,versions,comments,publication&versions_limit=1&comments_limit=1`,
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.slugId}?workspace_id=${workspace.id}&include=source,versions,comments,publication&versions_limit=1&comments_limit=1`,
      ),
    } as never);
    const body = (await response.json()) as {
      source: string;
      publication: { publication: { password_enabled: boolean } | null };
      versions: unknown[];
      threads: unknown[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.source).toContain("Published internals");
    expect(body.publication.publication?.password_enabled).toBe(true);
    expect(body.versions.length).toBeLessThanOrEqual(1);
    expect(body.threads.length).toBeLessThanOrEqual(1);
  });
});
