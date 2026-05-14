import { afterEach, describe, expect, it } from "vitest";
import {
  authService,
  pageService,
  workspaceService,
} from "../../../../lib/runtime";
import { POST as createComment } from "../[pageId]/comments";
import { PUT as updateSource } from "../[pageId]/source";

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
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Body Limits ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `body-limits-${crypto.randomUUID()}@example.test`,
    displayName: "Body Limit Editor",
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
    title: "Body limit page",
    sourceType: "markdown",
    source: "# Body limit page",
  });
  return {
    page: page.page,
    workspace,
    cookies: sessionCookies(authService.createSession(user.id).id),
  };
}

afterEach(() => {
  delete process.env.VPG_MAX_PAGE_SOURCE_BYTES;
  delete process.env.VPG_MAX_PUBLIC_COMMENT_BODY_BYTES;
});

describe("page API body limits", () => {
  it("rejects oversized page source before updating the page", async () => {
    process.env.VPG_MAX_PAGE_SOURCE_BYTES = "32";
    const { page, workspace, cookies } = await createEditablePage();

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
    expect((await pageService.getPage(page.id))?.source).toBe(
      "# Body limit page",
    );
  });

  it("rejects oversized comment bodies before creating a thread", async () => {
    process.env.VPG_MAX_PUBLIC_COMMENT_BODY_BYTES = "16";
    const { page, workspace, cookies } = await createEditablePage();

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
              content_hash: page.contentHash,
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
