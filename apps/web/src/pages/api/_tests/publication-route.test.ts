import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  pages as pagesService,
  publications as publicationsService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../lib/service-context";
import { indexPage } from "../../../lib/runtime";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-pub-test-"));
});
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
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const user = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `publisher-${crypto.randomUUID()}@example.test`,
    displayName: "Publisher",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Publication Fixture ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: user.id,
  });
  const { ctx: ownerCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    workspaceId: workspace.id,
  });
  ownerCtx.actor.userId = user.id;
  ownerCtx.actor.email = user.email;
  const created = await pagesService.create(ownerCtx, {
    workspaceId: workspace.id,
    folderPath: "",
    title: "Published Search Page",
    sourceType: "markdown",
    source: "# Published Search Page\n\nNeedle public body",
  });
  const page = created.data;
  await indexPage(page.page.id);
  const session = await auth.createSession(seedCtx, { userId: user.id });
  const cookies = sessionCookies(session.id);

  return {
    workspace,
    user,
    page,
    cookies,
  };
}

describe("publication API", () => {
  it("preserves omitted optional publication fields when publishing again", async () => {
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const user = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `publisher-${crypto.randomUUID()}@example.test`,
      displayName: "Publisher",
      role: "user",
    });
    const workspace = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: `Publication Preserve ${crypto.randomUUID()}`,
      slug: uniqueId("slug"),
      firstAdminUserId: user.id,
    });
    const session = await auth.createSession(seedCtx, { userId: user.id });
    const { ctx: ownerCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    ownerCtx.actor.userId = user.id;
    ownerCtx.actor.email = user.email;
    const created = await pagesService.create(ownerCtx, {
      workspaceId: workspace.id,
      folderPath: "",
      title: "Publish preserve",
      sourceType: "markdown",
      source: "# Publish preserve",
    });
    const page = created.data;
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
    const { ctx: lookupCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    const stored = await publicationsService.findForResource(lookupCtx, {
      workspaceId: workspace.id,
      resourceType: "page",
      resourceId: page.page.id,
    });

    expect(second.status).toBe(200);
    expect(payload.publication.permission).toBe("view");
    expect(payload.publication.expires_at).toBe("2099-01-01T00:00:00.000Z");
    expect(payload.publication.password_enabled).toBe(true);
    expect(payload.publication.indexing_enabled).toBe(true);
    expect(stored?.passwordHash).toBeTruthy();
  });

  it("verifies publication passwords, sets access cookies, and searches only the published page", async () => {
    const { workspace, page } = await createPublishablePageFixture();
    const { ctx: pubCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    const publication = await publicationsService.upsert(pubCtx, {
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
    expect(wrong.status).toBe(401);

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
    const { ctx: pubCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    const publication = await publicationsService.upsert(pubCtx, {
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
