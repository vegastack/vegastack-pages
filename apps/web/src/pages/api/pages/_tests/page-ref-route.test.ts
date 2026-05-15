import { describe, expect, it } from "vitest";
import { GET as getPage } from "../[pageId]";
import {
  authService,
  pageService,
  publicationService,
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

function request(path: string) {
  return new Request(`https://pages.example.test${path}`);
}

async function fixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Page Ref ${crypto.randomUUID()}`,
  });
  const admin = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `page-admin-${crypto.randomUUID()}@example.test`,
    displayName: "Page Admin",
    role: "user",
  });
  const reader = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `page-reader-${crypto.randomUUID()}@example.test`,
    displayName: "Page Reader",
    role: "user",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: admin.id,
    role: "admin",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: reader.id,
    role: "reader",
  });
  const page = await pageService.createPage({
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: "",
    title: "Published internals",
    sourceType: "markdown",
    source: "# Published internals",
  });
  await publicationService.upsert({
    workspaceId: workspace.id,
    resourceType: "page",
    resourceId: page.page.id,
    permission: "comment",
    password: "review-secret",
    indexingEnabled: true,
  });
  return { workspace, admin, reader, page };
}

describe("page ref API", () => {
  it("requires admin access before returning publication internals", async () => {
    const { workspace, reader, page } = await fixture();
    const response = await getPage({
      cookies: sessionCookies(authService.createSession(reader.id).id),
      params: { pageId: page.page.id },
      request: request(
        `/api/pages/${page.page.id}?workspace_id=${workspace.id}&include=publication`,
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.page.id}?workspace_id=${workspace.id}&include=publication`,
      ),
    } as never);

    expect(response.status).toBe(403);
  });

  it("returns bounded private page includes for admins", async () => {
    const { workspace, admin, page } = await fixture();
    const response = await getPage({
      cookies: sessionCookies(authService.createSession(admin.id).id),
      params: { pageId: page.page.slugId },
      request: request(
        `/api/pages/${page.page.slugId}?workspace_id=${workspace.id}&include=source,versions,comments,publication&versions_limit=1&comments_limit=1`,
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.page.slugId}?workspace_id=${workspace.id}&include=source,versions,comments,publication&versions_limit=1&comments_limit=1`,
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
