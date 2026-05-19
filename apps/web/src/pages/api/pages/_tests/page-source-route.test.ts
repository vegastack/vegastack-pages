import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { auth, pages, users, workspaces } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { createMcpSession } from "../../../../lib/runtime";

async function readPage(pageId: string) {
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  return pages.get(ctx, pageId);
}
import { POST as validateSource } from "../../validate-source";
import { POST as patchSource } from "../[pageId]/patch";
import { GET as getSource, PUT as updateSource } from "../[pageId]/source";
import { GET as listVersions } from "../[pageId]/versions";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-source-"));
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

function emptyCookies() {
  return {
    get() {
      return undefined;
    },
  } as never;
}

function apiUrl(path: string, workspaceId: string) {
  return `https://pages.example.test${path}?workspace_id=${workspaceId}`;
}

async function createEditablePage(title: string) {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: emptyCookies(),
  });
  const user = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `source-${crypto.randomUUID()}@example.test`,
    displayName: "Source Editor",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Source ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: user.id,
  });
  const session = await auth.createSession(seedCtx, { userId: user.id });
  const { ctx: actorCtx } = await buildServiceContext({
    cookies: sessionCookies(session.id),
    workspaceId: workspace.id,
  });
  const created = await pages.create(actorCtx, {
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: "",
    title,
    sourceType: "markdown",
    source: `# ${title}`,
  });
  return {
    cookies: sessionCookies(session.id),
    page: created.data.page,
    workspace,
  };
}

describe("page source API", () => {
  it("rejects unchanged saves and stale content hashes unless explicitly allowed", async () => {
    const { cookies, page, workspace } = await createEditablePage("Conflicts");

    const unchanged = await updateSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/source`, workspace.id),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "# Conflicts",
            base_version_id: page.versionId,
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/source`, workspace.id)),
    } as never);
    expect(unchanged.status).toBe(400);

    const staleHash = await updateSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/source`, workspace.id),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "# Conflicts\n\nChanged",
            base_version_id: page.versionId,
            base_content_hash: "stale",
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/source`, workspace.id)),
    } as never);
    expect(staleHash.status).toBe(409);

    const allowedNoop = await updateSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/source`, workspace.id),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "# Conflicts",
            base_version_id: page.versionId,
            allow_noop: true,
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/source`, workspace.id)),
    } as never);
    const allowedBody = (await allowedNoop.json()) as { changed?: boolean };
    expect(allowedNoop.status).toBe(200);
    expect(allowedBody.changed).toBe(false);
  });

  it("patches live source with explicit replacement counts", async () => {
    const { cookies, page, workspace } = await createEditablePage("Patch");
    await updateSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/source`, workspace.id),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "# Patch\n\nrepeat repeat",
            base_version_id: page.versionId,
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/source`, workspace.id)),
    } as never);
    const current = await readPage(page.id);
    expect(current).not.toBeNull();

    const mismatch = await patchSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/patch`, workspace.id),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            find: "repeat",
            replace: "done",
            replace_all: true,
            expected_replacements: 1,
            base_version_id: current?.page.versionId,
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/patch`, workspace.id)),
    } as never);
    expect(mismatch.status).toBe(409);

    const patched = await patchSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/patch`, workspace.id),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            find: "repeat",
            replace: "done",
            replace_all: true,
            expected_replacements: 2,
            base_version_id: current?.page.versionId,
            base_content_hash: current?.page.contentHash,
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/patch`, workspace.id)),
    } as never);
    const patchedBody = (await patched.json()) as {
      changed?: boolean;
      replacement_count?: number;
    };
    const stored = await readPage(page.id);

    expect(patched.status).toBe(200);
    expect(patchedBody.changed).toBe(true);
    expect(patchedBody.replacement_count).toBe(2);
    expect(stored?.source).toContain("done done");
  });

  it("validates the stored page source when no inline source is supplied", async () => {
    const { cookies, page, workspace } =
      await createEditablePage("Validate Stored");
    await updateSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/source`, workspace.id),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: [
              "# Validate Stored",
              "",
              "```mermaid",
              "xychart-beta",
              '  x-axis ["Q1", "Q2"]',
              "```",
            ].join("\n"),
            base_version_id: page.versionId,
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/source`, workspace.id)),
    } as never);
    const response = await validateSource({
      cookies,
      request: new Request("https://pages.example.test/api/validate-source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: workspace.id, page_id: page.id }),
      }),
      url: new URL(apiUrl("/api/validate-source", workspace.id)),
    } as never);
    const body = (await response.json()) as {
      valid?: boolean;
      diagnostics?: Array<{ code: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.diagnostics?.map((item) => item.code)).toContain(
      "mermaid_xychart_quoted_axis",
    );
  });

  it("scopes bearer token source reads to the MCP session workspace", async () => {
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: emptyCookies(),
    });
    const user = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `source-bearer-${crypto.randomUUID()}@example.test`,
      displayName: "Source Bearer",
    });
    const first = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: "Source Bearer First",
      slug: uniqueId("slug"),
      firstAdminUserId: user.id,
    });
    const second = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: "Source Bearer Second",
      slug: uniqueId("slug"),
      firstAdminUserId: user.id,
    });
    const userSession = await auth.createSession(seedCtx, {
      userId: user.id,
    });
    const { ctx: pageCtx } = await buildServiceContext({
      cookies: sessionCookies(userSession.id),
      workspaceId: second.id,
    });
    const created = await pages.create(pageCtx, {
      id: uniqueId("pg"),
      workspaceId: second.id,
      folderPath: "",
      title: "Other workspace",
      sourceType: "markdown",
      source: "# Other workspace",
    });
    const session = await createMcpSession({
      workspaceId: first.id,
      userId: user.id,
      clientName: "cli",
      protocolVersion: null,
    });

    const response = await getSource({
      cookies: emptyCookies(),
      params: { pageId: created.data.page.id },
      request: new Request(
        apiUrl(`/api/pages/${created.data.page.id}/source`, first.id),
        {
          headers: { authorization: `Bearer ${session.rawToken}` },
        },
      ),
      url: new URL(
        apiUrl(`/api/pages/${created.data.page.id}/source`, first.id),
      ),
    } as never);

    expect(response.status).toBe(403);
  });

  it("returns the edited timestamp after source updates", async () => {
    const { cookies, page, workspace } = await createEditablePage("Timestamp");

    const response = await updateSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        apiUrl(`/api/pages/${page.id}/source`, workspace.id),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "# Timestamp\n\nUpdated body",
            base_version_id: page.versionId,
          }),
        },
      ),
      url: new URL(apiUrl(`/api/pages/${page.id}/source`, workspace.id)),
    } as never);
    const body = (await response.json()) as {
      updated_at?: string;
      version_id?: string;
    };
    const stored = await readPage(page.id);

    expect(response.status).toBe(200);
    expect(body.updated_at).toBe(stored?.page.updatedAt);
    expect(body.version_id).toBe(stored?.page.versionId);
  });

  it("lists versions for only the requested page", async () => {
    const { cookies, page, workspace } = await createEditablePage("History A");
    const { ctx: seedCtx } = await buildServiceContext({
      cookies,
      workspaceId: workspace.id,
    });
    const otherPage = await pages.create(seedCtx, {
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "History B",
      sourceType: "markdown",
      source: "# History B",
    });

    const response = await listVersions({
      cookies,
      params: { pageId: page.id },
      url: new URL(apiUrl(`/api/pages/${page.id}/versions`, workspace.id)),
    } as never);
    const body = (await response.json()) as {
      versions?: Array<{ pageId: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.versions?.length).toBeGreaterThan(0);
    expect(body.versions?.every((version) => version.pageId === page.id)).toBe(
      true,
    );
    expect(
      body.versions?.some(
        (version) => version.pageId === otherPage.data.page.id,
      ),
    ).toBe(false);
  });
});
