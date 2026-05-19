import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  comments,
  pages,
  users,
  workspaces,
  type ServiceContext,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { DELETE } from "../[threadId]/index";
import { PATCH as updateAnchor } from "../[threadId]/anchor";
import { POST as completeThread } from "../[threadId]/complete";
import { POST as resolveThread } from "../[threadId]/resolve";
import { POST as unresolveThread } from "../[threadId]/unresolve";
import {
  GET as listComments,
  POST as createComment,
} from "../../pages/[pageId]/comments";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-comment-"));
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

type MemberRole = "admin" | "editor" | "commenter" | "reader";

type SeedFixture = {
  ctx: ServiceContext;
  user: { id: string; email: string };
  workspace: { id: string };
  session: { id: string };
  cookies: ReturnType<typeof sessionCookies>;
  page: {
    id: string;
    workspaceId: string;
    contentHash: string;
    slugId: string;
    versionId: string;
  };
};

async function seedFixture(input: {
  role: MemberRole;
  pageTitle: string;
  pageSource: string;
  pageSourceType?: "markdown" | "html" | "mdx";
  workspaceName: string;
  emailPrefix: string;
  displayName: string;
}): Promise<SeedFixture> {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: emptySeedCookies(),
  });
  const user = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `${input.emailPrefix}-${crypto.randomUUID()}@example.com`,
    displayName: input.displayName,
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: input.workspaceName,
    slug: uniqueId("slug"),
    firstAdminUserId: input.role === "admin" ? user.id : undefined,
  });
  if (input.role !== "admin") {
    await workspaces.addMember(seedCtx, {
      workspaceId: workspace.id,
      userId: user.id,
      role: input.role,
    });
  }
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
    sourceType: input.pageSourceType ?? "markdown",
    source: input.pageSource,
  });
  return {
    ctx: actorCtx,
    user,
    workspace,
    session,
    cookies: sessionCookies(session.id),
    page: created.data.page,
  };
}

async function threadStatus(
  ctx: ServiceContext,
  threadId: string,
): Promise<string | null> {
  const row = await ctx
    .db!.prepare("SELECT status FROM comment_threads WHERE id = ?1")
    .bind(threadId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

type AnchorSelector = {
  point?: { x?: number; y?: number; coordinateSpace?: string };
  documentPoint?: { x?: number; y?: number };
  element?: { tag?: string };
  textHit?: { exact?: string };
  nearbyText?: string;
};

async function loadAnchor(
  ctx: ServiceContext,
  threadId: string,
): Promise<{
  selector: AnchorSelector | null;
  confidence: string | null;
}> {
  const row = await ctx
    .db!.prepare(
      "SELECT selector_json, confidence FROM comment_anchors WHERE thread_id = ?1",
    )
    .bind(threadId)
    .first<{ selector_json: string | null; confidence: string | null }>();
  return {
    selector: row?.selector_json
      ? (JSON.parse(row.selector_json) as AnchorSelector)
      : null,
    confidence: row?.confidence ?? null,
  };
}

describe("comment thread API", () => {
  it("adds agent-attributed replies and resolves threads in one call", async () => {
    const fixture = await seedFixture({
      role: "admin",
      pageTitle: "Complete page",
      pageSource: "# Complete page",
      workspaceName: "Comment Complete Test",
      emailPrefix: "complete",
      displayName: "Comment Completer",
    });

    const thread = await comments.createThread(fixture.ctx, {
      pageId: fixture.page.id,
      workspaceId: fixture.workspace.id,
      body: "Needs completion",
      authorUserId: fixture.user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: {
        selectedText: "Complete page",
        sourceStart: 0,
        sourceEnd: 15,
        prefixText: "",
        suffixText: "",
        contentHash: fixture.page.contentHash,
      },
    });

    const response = await completeThread({
      cookies: fixture.cookies,
      params: { threadId: thread.data.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/complete?workspace_id=${fixture.workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: "Implemented and verified.",
            resolve: true,
            agent_name: "Codex",
            agent_model: "gpt-test",
            agent_session_id: "agt_test",
          }),
        },
      ),
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/complete?workspace_id=${fixture.workspace.id}`,
      ),
    } as never);
    const body = (await response.json()) as {
      reply?: { authorType: string; agentName?: string; agentModel?: string };
      resolved?: { status: string };
    };

    expect(response.status).toBe(200);
    expect(body.reply).toMatchObject({
      authorType: "agent",
      agentName: "Codex",
      agentModel: "gpt-test",
    });
    expect(body.resolved?.status).toBe("resolved");
    expect(await threadStatus(fixture.ctx, thread.data.thread.id)).toBe(
      "resolved",
    );
  });

  it("moves threads between open and resolved list filters", async () => {
    const fixture = await seedFixture({
      role: "commenter",
      pageTitle: "Resolve page",
      pageSource: "# Resolve page",
      workspaceName: "Comment Resolve Test",
      emailPrefix: "resolve",
      displayName: "Resolve Reviewer",
    });
    const thread = await comments.createThread(fixture.ctx, {
      pageId: fixture.page.id,
      workspaceId: fixture.workspace.id,
      body: "Resolve this",
      authorUserId: fixture.user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: {
        selectedText: "Resolve page",
        sourceStart: 0,
        sourceEnd: 12,
        prefixText: "",
        suffixText: "",
        contentHash: fixture.page.contentHash,
      },
    });

    const base = `https://pages.example.test/api/pages/${fixture.page.id}/comments?workspace_id=${fixture.workspace.id}`;
    const resolvedResponse = await resolveThread({
      cookies: fixture.cookies,
      params: { threadId: thread.data.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/resolve?workspace_id=${fixture.workspace.id}`,
        { method: "POST" },
      ),
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/resolve?workspace_id=${fixture.workspace.id}`,
      ),
    } as never);

    expect(resolvedResponse.status).toBe(200);
    expect(await threadStatus(fixture.ctx, thread.data.thread.id)).toBe(
      "resolved",
    );

    // Sync the new D1 status into the legacy in-memory cache that
    // the listing route still reads.

    const openList = (await (
      await listComments({
        cookies: fixture.cookies,
        params: { pageId: fixture.page.id },
        request: new Request(base),
        url: new URL(base),
      } as never)
    ).json()) as { threads: Array<{ thread: { id: string } }> };
    const resolvedList = (await (
      await listComments({
        cookies: fixture.cookies,
        params: { pageId: fixture.page.id },
        request: new Request(`${base}&status=resolved`),
        url: new URL(`${base}&status=resolved`),
      } as never)
    ).json()) as { threads: Array<{ thread: { id: string } }> };

    expect(openList.threads).toHaveLength(0);
    expect(resolvedList.threads.map((entry) => entry.thread.id)).toContain(
      thread.data.thread.id,
    );

    const reopenedResponse = await unresolveThread({
      cookies: fixture.cookies,
      params: { threadId: thread.data.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/unresolve?workspace_id=${fixture.workspace.id}`,
        { method: "POST" },
      ),
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/unresolve?workspace_id=${fixture.workspace.id}`,
      ),
    } as never);

    expect(reopenedResponse.status).toBe(200);
    expect(await threadStatus(fixture.ctx, thread.data.thread.id)).toBe("open");
  });

  it("does not let comment-only users delete whole threads", async () => {
    const fixture = await seedFixture({
      role: "commenter",
      pageTitle: "Comment page",
      pageSource: "# Comment page",
      workspaceName: "Comment Delete Test",
      emailPrefix: "commenter",
      displayName: "Commenter",
    });
    const thread = await comments.createThread(fixture.ctx, {
      pageId: fixture.page.id,
      workspaceId: fixture.workspace.id,
      body: "Needs review",
      authorUserId: fixture.user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: {
        selectedText: "Comment page",
        sourceStart: 0,
        sourceEnd: 12,
        prefixText: "",
        suffixText: "",
        contentHash: fixture.page.contentHash,
      },
    });

    const response = await DELETE({
      cookies: fixture.cookies,
      params: { threadId: thread.data.thread.id },
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}?workspace_id=${fixture.workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(403);
    expect(
      await threadStatus(fixture.ctx, thread.data.thread.id),
    ).not.toBeNull();
  });

  it("creates HTML text selection comments with quote selectors", async () => {
    const fixture = await seedFixture({
      role: "commenter",
      pageTitle: "HTML page",
      pageSource: "<main><p>Inline HTML review text lives here.</p></main>",
      pageSourceType: "html",
      workspaceName: "HTML Text Comment Test",
      emailPrefix: "html-text",
      displayName: "HTML Reviewer",
    });
    const url = `https://pages.example.test/api/pages/${fixture.page.id}/comments?workspace_id=${fixture.workspace.id}`;

    const response = await createComment({
      cookies: fixture.cookies,
      params: { pageId: fixture.page.id },
      request: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "This selection needs a comment",
          anchor: {
            selected_text: "HTML review text",
            source_start: null,
            source_end: null,
            rendered_dom_path: "main:nth-of-type(1)>p:nth-of-type(1)",
            prefix_text: "Inline ",
            suffix_text: " lives here.",
            content_hash: fixture.page.contentHash,
            anchor_kind: "text",
            surface: "html",
            confidence: "active",
            selector: {
              quote: {
                exact: "HTML review text",
                prefix: "Inline ",
                suffix: " lives here.",
              },
              position: {
                sourceStart: null,
                sourceEnd: null,
                renderedStart: 7,
                renderedEnd: 23,
              },
              element: {
                path: "main:nth-of-type(1)>p:nth-of-type(1)",
                tag: "p",
                text: "Inline HTML review text lives here.",
              },
            },
          },
        }),
      }),
      url: new URL(url),
    } as never);
    const body = (await response.json()) as {
      anchor: {
        kind: string;
        surface: string;
        selector?: {
          quote?: { exact: string };
          position?: { renderedStart?: number | null };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.anchor.kind).toBe("text");
    expect(body.anchor.surface).toBe("html");
    expect(body.anchor.selector?.quote?.exact).toBe("HTML review text");
    expect(body.anchor.selector?.position?.renderedStart).toBe(7);
  });

  it("lets commenters update open visual anchors with validated coordinates", async () => {
    const fixture = await seedFixture({
      role: "commenter",
      pageTitle: "Anchor page",
      pageSource: "# Anchor page",
      workspaceName: "Comment Anchor Test",
      emailPrefix: "anchor",
      displayName: "Anchor Reviewer",
    });
    const thread = await comments.createThread(fixture.ctx, {
      pageId: fixture.page.id,
      workspaceId: fixture.workspace.id,
      body: "Move this",
      authorUserId: fixture.user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: {
        selectedText: "Pinned comment",
        sourceStart: null,
        sourceEnd: null,
        prefixText: "",
        suffixText: "",
        contentHash: fixture.page.contentHash,
        kind: "point",
        surface: "prose",
        selector: {
          point: { x: 0.1, y: 0.1, coordinateSpace: "document" },
        },
        confidence: "manual",
      },
    });

    const response = await updateAnchor({
      cookies: fixture.cookies,
      params: { threadId: thread.data.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/anchor?workspace_id=${fixture.workspace.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anchor: {
              selected_text: "Pinned comment",
              anchor_kind: "point",
              surface: "prose",
              content_hash: fixture.page.contentHash,
              confidence: "manual",
              selector: {
                point: {
                  x: 0.45,
                  y: 0.55,
                  coordinateSpace: "element",
                  elementPath: "main:nth-of-type(1)>h1:nth-of-type(1)",
                },
                documentPoint: {
                  x: 2,
                  y: -1,
                  coordinateSpace: "document",
                },
                element: {
                  path: "main:nth-of-type(1)>h1:nth-of-type(1)",
                  fingerprint: "h1|Hero headline",
                  tag: "h1",
                  className: "hero-title",
                  text: "Hero headline",
                },
                textHit: {
                  exact: "Hero",
                  prefix: "",
                  suffix: " headline",
                  renderedStart: 0,
                  renderedEnd: 4,
                },
                nearbyText: "Hero headline",
              },
            },
          }),
        },
      ),
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/anchor?workspace_id=${fixture.workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(200);
    const updated = await loadAnchor(fixture.ctx, thread.data.thread.id);
    expect(updated.selector?.point?.x).toBe(0.45);
    expect(updated.selector?.point?.y).toBe(0.55);
    expect(updated.selector?.point?.coordinateSpace).toBe("element");
    expect(updated.selector?.documentPoint?.x).toBe(1);
    expect(updated.selector?.documentPoint?.y).toBe(0);
    expect(updated.selector?.element?.tag).toBe("h1");
    expect(updated.selector?.textHit?.exact).toBe("Hero");
    expect(updated.selector?.nearbyText).toBe("Hero headline");
    expect(updated.confidence).toBe("manual");
  });

  it("rejects malformed anchor updates", async () => {
    const fixture = await seedFixture({
      role: "commenter",
      pageTitle: "Anchor page",
      pageSource: "# Anchor page",
      workspaceName: "Comment Anchor Invalid Test",
      emailPrefix: "anchor-invalid",
      displayName: "Anchor Reviewer",
    });
    const thread = await comments.createThread(fixture.ctx, {
      pageId: fixture.page.id,
      workspaceId: fixture.workspace.id,
      body: "Move this",
      authorUserId: fixture.user.id,
      guestName: null,
      guestSessionId: null,
      publicationId: null,
      anchor: {
        selectedText: "Pinned comment",
        sourceStart: null,
        sourceEnd: null,
        prefixText: "",
        suffixText: "",
        contentHash: fixture.page.contentHash,
        kind: "point",
        surface: "prose",
        selector: {
          point: { x: 0.1, y: 0.1, coordinateSpace: "document" },
        },
        confidence: "manual",
      },
    });

    const response = await updateAnchor({
      cookies: fixture.cookies,
      params: { threadId: thread.data.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/anchor?workspace_id=${fixture.workspace.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anchor: {
              anchor_kind: "rect",
              selector: { rect: { x: 0, y: 0, width: 0.2, height: 0.2 } },
            },
          }),
        },
      ),
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.data.thread.id}/anchor?workspace_id=${fixture.workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(400);
  });
});
