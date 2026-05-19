import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  pages as pagesService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { POST as createComment } from "../[pageId]/comments";
import { PUT as updateSource } from "../[pageId]/source";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-body-limits-"));
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

async function createEditablePage() {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const user = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `body-limits-${crypto.randomUUID()}@example.test`,
    displayName: "Body Limit Editor",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `Body Limits ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: user.id,
  });
  const session = await auth.createSession(seedCtx, { userId: user.id });
  const { ctx: actorCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    workspaceId: workspace.id,
  });
  actorCtx.actor.userId = user.id;
  actorCtx.actor.email = user.email;
  const created = await pagesService.create(actorCtx, {
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: "",
    title: "Body limit page",
    sourceType: "markdown",
    source: "# Body limit page",
  });
  return {
    page: created.data.page,
    contentHash: created.data.page.contentHash,
    workspace,
    actorCtx,
    cookies: sessionCookies(session.id),
  };
}

afterEach(() => {
  delete process.env.VPG_MAX_PAGE_SOURCE_BYTES;
  delete process.env.VPG_MAX_PUBLIC_COMMENT_BODY_BYTES;
});

describe("page API body limits", () => {
  it("rejects oversized page source before updating the page", async () => {
    process.env.VPG_MAX_PAGE_SOURCE_BYTES = "32";
    const { page, workspace, cookies, actorCtx } = await createEditablePage();

    const response = await updateSource({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/source?workspace_id=${workspace.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "# Oversized\n\n" + "x".repeat(64),
            base_version_id: page.versionId,
          }),
        },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}/source?workspace_id=${workspace.id}`,
      ),
    } as never);
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(413);
    expect(body.error?.code).toBe("PAYLOAD_TOO_LARGE");
    const after = await pagesService.get(actorCtx, page.id);
    expect(after?.source).toBe("# Body limit page");
  });

  it("rejects oversized comment bodies before creating a thread", async () => {
    process.env.VPG_MAX_PUBLIC_COMMENT_BODY_BYTES = "16";
    const { page, workspace, cookies, contentHash } =
      await createEditablePage();

    const response = await createComment({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/comments?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: "x".repeat(32),
            anchor: {
              selected_text: "Body",
              source_start: 2,
              source_end: 6,
              content_hash: contentHash,
            },
          }),
        },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}/comments?workspace_id=${workspace.id}`,
      ),
    } as never);
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(413);
    expect(body.error?.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
