import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { auth, pages, users, workspaces } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { POST as createComment } from "../[pageId]/comments";
import { GET as listEvents } from "../[pageId]/events";
import { GET as listReviewEvents } from "../../review-events";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-events-"));
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

function emptySeedCookies() {
  return { get: () => undefined } as never;
}

async function seedAdminWithPage(input: {
  workspaceName: string;
  pageTitle: string;
  pageSource: string;
}) {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: emptySeedCookies(),
  });
  const user = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `events-${crypto.randomUUID()}@example.test`,
    displayName: "Events Admin",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: input.workspaceName,
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
    title: input.pageTitle,
    sourceType: "markdown",
    source: input.pageSource,
  });
  return {
    user,
    workspace,
    session,
    cookies: sessionCookies(session.id),
    page: created.data.page,
  };
}

describe("page review events API", () => {
  it("lists workspace-scoped review events through the standalone API", async () => {
    const { workspace, cookies, page } = await seedAdminWithPage({
      workspaceName: `Review Events ${crypto.randomUUID()}`,
      pageTitle: "Workspace Review Events",
      pageSource: "# Workspace Review Events",
    });

    await createComment({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/comments?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: "workspace event body",
            anchor: { selected_text: "Workspace Review Events" },
          }),
        },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}/comments?workspace_id=${workspace.id}`,
      ),
    } as never);

    const response = await listReviewEvents({
      cookies,
      request: new Request(
        `https://pages.example.test/api/review-events?workspace_id=${workspace.id}&limit=500`,
      ),
      url: new URL(
        `https://pages.example.test/api/review-events?workspace_id=${workspace.id}&limit=500`,
      ),
    } as never);
    const body = (await response.json()) as {
      events?: Array<{ pageId: string; type: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.events?.some((event) => event.pageId === page.id)).toBe(true);
    expect(body.events?.some((event) => event.type === "comment.created")).toBe(
      true,
    );
  });

  it("does not expose comment bodies or selected text in event payloads", async () => {
    const { workspace, cookies, page } = await seedAdminWithPage({
      workspaceName: `Events ${crypto.randomUUID()}`,
      pageTitle: "Events",
      pageSource: "# Events",
    });

    await createComment({
      cookies,
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/comments?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: "secret review body",
            anchor: { selected_text: "secret selected text" },
          }),
        },
      ),
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}/comments?workspace_id=${workspace.id}`,
      ),
    } as never);

    const response = await listEvents({
      cookies,
      params: { pageId: page.id },
      url: new URL(
        `https://pages.example.test/api/pages/${page.id}/events?workspace_id=${workspace.id}`,
      ),
    } as never);
    const body = (await response.json()) as {
      events?: Array<{ type: string; payload?: Record<string, unknown> }>;
    };
    const event = body.events?.find((item) => item.type === "comment.created");

    expect(response.status).toBe(200);
    expect(event?.payload).toEqual(
      expect.objectContaining({ thread_id: expect.any(String) }),
    );
    expect(event?.payload).not.toHaveProperty("body");
    expect(event?.payload).not.toHaveProperty("selected_text");
    expect(JSON.stringify(body.events)).not.toContain("secret review body");
    expect(JSON.stringify(body.events)).not.toContain("secret selected text");
  });
});
