// Partial endpoint tests for the document payload API.
//
// Tests both the page and folder variants. The route is a thin adapter
// around buildPageDocumentPayload / buildFolderDocumentPayload; this
// suite focuses on the HTTP shape — status codes, headers, and the
// integration of resolvePageAccess with the builder.

import { describe, expect, it } from "vitest";
import {
  authService,
  pageService,
  workspaceService,
} from "../../../lib/runtime";
import { GET as getPageDocument } from "../workspaces/[workspaceId]/documents/page/[ref]";
import { GET as getFolderDocument } from "../workspaces/[workspaceId]/documents/folder/[ref]";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function sessionCookies(sessionId: string | null) {
  return {
    get(name: string) {
      if (name === "vpg_session" && sessionId) return { value: sessionId };
      return undefined;
    },
  } as never;
}

async function seedAuthedFixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Documents Route Fixture ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `docroute-${crypto.randomUUID()}@example.test`,
    displayName: "Document Reader",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: user.id,
    role: "admin",
  });
  const page = await pageService.createPage({
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: "",
    title: "Routed Document",
    sourceType: "markdown",
    source:
      "---\ntitle: Routed Document\ndescription: Probe.\n---\n\n# Routed Document\n\nProse body.",
  });
  const folder = workspaceService.createFolder({
    id: uniqueId("fl"),
    workspaceId: workspace.id,
    name: "Topics",
    parentFolderId: null,
  });
  const sessionId = authService.createSession(user.id).id;
  return { workspace, user, page, folder, sessionId };
}

describe("GET /api/workspaces/:wid/documents/page/:ref", () => {
  it("returns a DocumentPayload for a member who can read the page", async () => {
    const { workspace, page, sessionId } = await seedAuthedFixture();
    const response = await getPageDocument({
      cookies: sessionCookies(sessionId),
      params: { workspaceId: workspace.id, ref: page.page.slugId },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.slugId}?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.slugId}?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as {
      kind: string;
      page: { id: string; slug_id: string; title: string };
      tree_version: string;
      cache_control: string;
      document_html: string;
      permissions: { canEdit: boolean; role: string };
    };
    expect(body.kind).toBe("page");
    expect(body.page.id).toBe(page.page.id);
    expect(body.page.slug_id).toBe(page.page.slugId);
    expect(body.page.title).toBe("Routed Document");
    expect(body.tree_version).toMatch(/^nav_/);
    expect(body.cache_control).toBe("private, no-store");
    expect(body.document_html).toContain("Prose body");
    expect(body.permissions.canEdit).toBe(true);
    expect(body.permissions.role).toBe("Owner");
  });

  it("accepts the pg_* id ref as well as the slug_id", async () => {
    const { workspace, page, sessionId } = await seedAuthedFixture();
    const response = await getPageDocument({
      cookies: sessionCookies(sessionId),
      params: { workspaceId: workspace.id, ref: page.page.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.id}?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.id}?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { page: { id: string } };
    expect(body.page.id).toBe(page.page.id);
  });

  it("404s for an unknown ref", async () => {
    const { workspace, sessionId } = await seedAuthedFixture();
    const response = await getPageDocument({
      cookies: sessionCookies(sessionId),
      params: { workspaceId: workspace.id, ref: "no-such-ref" },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/no-such-ref?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/no-such-ref?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(404);
  });

  it("404s when the page exists but in a different workspace", async () => {
    const { page, sessionId } = await seedAuthedFixture();
    const otherWorkspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Other Workspace",
    });
    const response = await getPageDocument({
      cookies: sessionCookies(sessionId),
      params: { workspaceId: otherWorkspace.id, ref: page.page.slugId },
      request: new Request(
        `https://pages.example.test/api/workspaces/${otherWorkspace.id}/documents/page/${page.page.slugId}?workspace_id=${otherWorkspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${otherWorkspace.id}/documents/page/${page.page.slugId}?workspace_id=${otherWorkspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(404);
  });
});

describe("GET /api/workspaces/:wid/documents/folder/:ref", () => {
  it("returns a folder payload with workspace breadcrumb", async () => {
    const { workspace, folder, sessionId } = await seedAuthedFixture();
    const response = await getFolderDocument({
      cookies: sessionCookies(sessionId),
      params: { workspaceId: workspace.id, ref: folder.slugId },
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/folder/${folder.slugId}?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as {
      kind: string;
      folder: { id: string };
      breadcrumb: { items: Array<{ kind: string; id: string }> };
    };
    expect(body.kind).toBe("folder");
    expect(body.folder.id).toBe(folder.id);
    expect(body.breadcrumb.items[0].kind).toBe("workspace");
    expect(body.breadcrumb.items[body.breadcrumb.items.length - 1].id).toBe(
      folder.id,
    );
  });

  it("404s for an unknown folder", async () => {
    const { workspace, sessionId } = await seedAuthedFixture();
    const response = await getFolderDocument({
      cookies: sessionCookies(sessionId),
      params: { workspaceId: workspace.id, ref: "no-such-folder" },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/folder/no-such-folder?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/folder/no-such-folder?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(404);
  });
});

// Audit-cycle-3-findings.md F-020: negative-path tests for the partial
// endpoints. These cover the risky access cases the original suite
// missed: anonymous, non-member, and cross-workspace bearer.
describe("partial endpoint access negatives (F-020)", () => {
  it("returns 401/403 for an anonymous request to a non-public page", async () => {
    const { workspace, page } = await seedAuthedFixture();
    const response = await getPageDocument({
      cookies: sessionCookies(null),
      params: { workspaceId: workspace.id, ref: page.page.slugId },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.slugId}?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.slugId}?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect([401, 403, 404]).toContain(response.status);
  });

  it("returns 403/404 for a logged-in non-member trying to read a page", async () => {
    const { workspace, page } = await seedAuthedFixture();
    const outsider = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `outsider-${crypto.randomUUID()}@example.test`,
      displayName: "Outsider",
    });
    const outsiderSession = authService.createSession(outsider.id).id;
    const response = await getPageDocument({
      cookies: sessionCookies(outsiderSession),
      params: { workspaceId: workspace.id, ref: page.page.slugId },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.slugId}?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/page/${page.page.slugId}?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect([401, 403, 404]).toContain(response.status);
  });

  it("returns 401/403 for an anonymous folder request", async () => {
    const { workspace, folder } = await seedAuthedFixture();
    const response = await getFolderDocument({
      cookies: sessionCookies(null),
      params: { workspaceId: workspace.id, ref: folder.slugId },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/folder/${folder.slugId}?workspace_id=${workspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${workspace.id}/documents/folder/${folder.slugId}?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect([401, 403, 404]).toContain(response.status);
  });

  it("404s when the folder belongs to a different workspace (cross-workspace)", async () => {
    const { folder, sessionId } = await seedAuthedFixture();
    const otherWorkspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Other Workspace ${crypto.randomUUID()}`,
    });
    const response = await getFolderDocument({
      cookies: sessionCookies(sessionId),
      params: { workspaceId: otherWorkspace.id, ref: folder.slugId },
      request: new Request(
        `https://pages.example.test/api/workspaces/${otherWorkspace.id}/documents/folder/${folder.slugId}?workspace_id=${otherWorkspace.id}`,
      ),
      url: new URL(
        `https://pages.example.test/api/workspaces/${otherWorkspace.id}/documents/folder/${folder.slugId}?workspace_id=${otherWorkspace.id}`,
      ),
    } as never);
    expect(response.status).toBe(404);
  });
});
