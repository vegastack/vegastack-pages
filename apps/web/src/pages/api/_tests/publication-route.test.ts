import { describe, expect, it } from "vitest";
import {
  authService,
  indexPage,
  pageService,
  publicationService,
  workspaceService,
} from "../../../lib/runtime";
import { PUT as publishPage } from "../pages/[pageId]/publication";
import {
  DELETE as revokePublication,
  PATCH as updatePublication,
} from "../publications/[publicationId]/index";
import { GET as searchPublication } from "../publications/[publicationId]/search";
import { POST as verifyPublicationPassword } from "../publications/[publicationId]/verify-password";

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

function mutableCookies(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get(name: string) {
      const value = values.get(name);
      return value ? { value } : undefined;
    },
    set(name: string, value: string) {
      values.set(name, value);
    },
    values,
  };
}

function apiRequest(path: string, init?: RequestInit) {
  return new Request(`https://pages.example.test${path}`, init);
}

function jsonRequest(path: string, body: unknown, init: RequestInit = {}) {
  return apiRequest(path, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  });
}

async function createPublishablePageFixture() {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Publication Fixture ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `publisher-${crypto.randomUUID()}@example.test`,
    displayName: "Publisher",
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
    title: "Published Search Page",
    sourceType: "markdown",
    source: "# Published Search Page\n\nNeedle public body",
  });
  await indexPage(page.page.id);

  return {
    workspace,
    user,
    page,
    cookies: sessionCookies(authService.createSession(user.id).id),
  };
}

describe("publication API", () => {
  it("preserves omitted optional publication fields when publishing again", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Publication Preserve ${crypto.randomUUID()}`,
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `publisher-${crypto.randomUUID()}@example.test`,
      displayName: "Publisher",
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
      title: "Publish preserve",
      sourceType: "markdown",
      source: "# Publish preserve",
    });
    const cookies = sessionCookies(session.id);

    const first = await publishPage({
      cookies,
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/publication?workspace_id=${workspace.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            permission: "comment",
            expires_at: "2099-01-01T00:00:00.000Z",
            password: "strong-passphrase",
            indexing_enabled: true,
          }),
        },
      ),
    } as never);
    expect(first.status).toBe(200);

    const second = await publishPage({
      cookies,
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/publication?workspace_id=${workspace.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permission: "view" }),
        },
      ),
    } as never);
    const payload = (await second.json()) as {
      publication: {
        permission: string;
        expires_at: string | null;
        password_enabled: boolean;
        indexing_enabled: boolean;
      };
    };
    const stored = publicationService.findForResource("page", page.page.id);

    expect(second.status).toBe(200);
    expect(payload.publication.permission).toBe("view");
    expect(payload.publication.expires_at).toBe("2099-01-01T00:00:00.000Z");
    expect(payload.publication.password_enabled).toBe(true);
    expect(payload.publication.indexing_enabled).toBe(true);
    expect(stored?.passwordHash).toBeTruthy();
  });

  it("verifies publication passwords, sets access cookies, and searches only the published page", async () => {
    const { workspace, page } = await createPublishablePageFixture();
    const publication = await publicationService.upsert({
      workspaceId: workspace.id,
      resourceType: "page",
      resourceId: page.page.id,
      permission: "comment",
      password: "strong-passphrase",
      indexingEnabled: true,
    });
    const cookies = mutableCookies();

    const wrong = await verifyPublicationPassword({
      cookies,
      params: { publicationId: publication.id },
      request: jsonRequest(
        `/api/publications/${publication.id}/verify-password?workspace_id=${workspace.id}`,
        { password: "wrong" },
      ),
      url: new URL(
        `https://pages.example.test/api/publications/${publication.id}/verify-password?workspace_id=${workspace.id}`,
      ),
    } as never);
    expect(wrong.status).toBe(403);

    const verified = await verifyPublicationPassword({
      cookies,
      params: { publicationId: publication.id },
      request: jsonRequest(
        `/api/publications/${publication.id}/verify-password?workspace_id=${workspace.id}`,
        { password: "strong-passphrase" },
      ),
      url: new URL(
        `https://pages.example.test/api/publications/${publication.id}/verify-password?workspace_id=${workspace.id}`,
      ),
    } as never);
    const verifiedBody = (await verified.json()) as {
      publication_id: string;
      permission: string;
    };

    expect(verified.status).toBe(200);
    expect(verifiedBody).toMatchObject({
      publication_id: publication.id,
      permission: "comment",
    });
    expect(
      [...cookies.values.keys()].some((name) => name.startsWith("vpg_pub_")),
    ).toBe(true);

    const search = await searchPublication({
      cookies,
      params: { publicationId: publication.id },
      url: new URL(
        `https://pages.example.test/api/publications/${publication.id}/search?q=needle`,
      ),
    } as never);
    const searchBody = (await search.json()) as {
      results: Array<{ pageId: string | null; title: string }>;
    };

    expect(search.status).toBe(200);
    expect(searchBody.results).toEqual([
      expect.objectContaining({
        pageId: page.page.id,
        title: "Published Search Page",
      }),
    ]);
  });

  it("updates and revokes publications through admin-only publication routes", async () => {
    const { workspace, page, cookies } = await createPublishablePageFixture();
    const publication = await publicationService.upsert({
      workspaceId: workspace.id,
      resourceType: "page",
      resourceId: page.page.id,
      permission: "view",
      password: "strong-passphrase",
    });

    const updatedResponse = await updatePublication({
      cookies,
      params: { publicationId: publication.id },
      request: jsonRequest(
        `/api/publications/${publication.id}?workspace_id=${workspace.id}`,
        {
          permission: "edit",
          password: "",
          indexing_enabled: true,
          expires_at: null,
        },
        { method: "PATCH" },
      ),
      url: new URL(
        `https://pages.example.test/api/publications/${publication.id}?workspace_id=${workspace.id}`,
      ),
    } as never);
    const updated = (await updatedResponse.json()) as {
      publication: {
        permission: string;
        passwordHash: string | null;
        indexingEnabled: boolean;
      };
    };

    expect(updatedResponse.status).toBe(200);
    expect(updated.publication).toMatchObject({
      permission: "edit",
      passwordHash: null,
      indexingEnabled: true,
    });

    const revokedResponse = await revokePublication({
      cookies,
      params: { publicationId: publication.id },
      request: apiRequest(
        `/api/publications/${publication.id}?workspace_id=${workspace.id}`,
        { method: "DELETE" },
      ),
      url: new URL(
        `https://pages.example.test/api/publications/${publication.id}?workspace_id=${workspace.id}`,
      ),
    } as never);
    const revoked = (await revokedResponse.json()) as {
      publication: { revokedAt: string | null };
    };

    expect(revokedResponse.status).toBe(200);
    expect(revoked.publication.revokedAt).toEqual(expect.any(String));

    const searchAfterRevoke = await searchPublication({
      cookies: mutableCookies(),
      params: { publicationId: publication.id },
      url: new URL(
        `https://pages.example.test/api/publications/${publication.id}/search?q=needle`,
      ),
    } as never);
    expect(searchAfterRevoke.status).toBe(404);
  });
});
