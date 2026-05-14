import { describe, expect, it } from "vitest";
import { DELETE } from "../[threadId]/index";
import { PATCH as updateAnchor } from "../[threadId]/anchor";
import { POST as completeThread } from "../[threadId]/complete";
import { POST as resolveThread } from "../[threadId]/resolve";
import { POST as unresolveThread } from "../[threadId]/unresolve";
import {
  GET as listComments,
  POST as createComment,
} from "../../pages/[pageId]/comments";
import {
  authService,
  commentService,
  pageService,
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

describe("comment thread API", () => {
  it("adds agent-attributed replies and resolves threads in one call", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Comment Complete Test",
    });
    const admin = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `complete-${crypto.randomUUID()}@example.com`,
      displayName: "Comment Completer",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: admin.id,
      role: "admin",
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Complete page",
      sourceType: "markdown",
      source: "# Complete page",
    });
    const thread = commentService.createThread({
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Needs completion",
      authorUserId: admin.id,
      anchor: {
        selectedText: "Complete page",
        sourceStart: 0,
        sourceEnd: 15,
        prefixText: "",
        suffixText: "",
        contentHash: page.page.contentHash,
      },
    });

    const response = await completeThread({
      cookies: sessionCookies(authService.createSession(admin.id).id),
      params: { threadId: thread.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/complete?workspace_id=${workspace.id}`,
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
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/complete?workspace_id=${workspace.id}`,
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
    expect(commentService.getThread(thread.thread.id)?.thread.status).toBe(
      "resolved",
    );
  });

  it("moves threads between open and resolved list filters", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Comment Resolve Test",
    });
    const commenter = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `resolve-${crypto.randomUUID()}@example.com`,
      displayName: "Resolve Reviewer",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: commenter.id,
      role: "commenter",
    });
    const session = authService.createSession(commenter.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Resolve page",
      sourceType: "markdown",
      source: "# Resolve page",
    });
    const thread = commentService.createThread({
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Resolve this",
      authorUserId: commenter.id,
      anchor: {
        selectedText: "Resolve page",
        sourceStart: 0,
        sourceEnd: 12,
        prefixText: "",
        suffixText: "",
        contentHash: page.page.contentHash,
      },
    });

    const base = `https://pages.example.test/api/pages/${page.page.id}/comments?workspace_id=${workspace.id}`;
    const resolvedResponse = await resolveThread({
      cookies: sessionCookies(session.id),
      params: { threadId: thread.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/resolve?workspace_id=${workspace.id}`,
        { method: "POST" },
      ),
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/resolve?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(resolvedResponse.status).toBe(200);
    expect(commentService.getThread(thread.thread.id)?.thread.status).toBe(
      "resolved",
    );

    const openList = (await (
      await listComments({
        cookies: sessionCookies(session.id),
        params: { pageId: page.page.id },
        request: new Request(base),
        url: new URL(base),
      } as never)
    ).json()) as { threads: Array<{ thread: { id: string } }> };
    const resolvedList = (await (
      await listComments({
        cookies: sessionCookies(session.id),
        params: { pageId: page.page.id },
        request: new Request(`${base}&status=resolved`),
        url: new URL(`${base}&status=resolved`),
      } as never)
    ).json()) as { threads: Array<{ thread: { id: string } }> };

    expect(openList.threads).toHaveLength(0);
    expect(resolvedList.threads.map((entry) => entry.thread.id)).toContain(
      thread.thread.id,
    );

    const reopenedResponse = await unresolveThread({
      cookies: sessionCookies(session.id),
      params: { threadId: thread.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/unresolve?workspace_id=${workspace.id}`,
        { method: "POST" },
      ),
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/unresolve?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(reopenedResponse.status).toBe(200);
    expect(commentService.getThread(thread.thread.id)?.thread.status).toBe(
      "open",
    );
  });

  it("does not let comment-only users delete whole threads", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Comment Delete Test",
    });
    const commenter = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `commenter-${crypto.randomUUID()}@example.com`,
      displayName: "Commenter",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: commenter.id,
      role: "commenter",
    });
    const session = authService.createSession(commenter.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Comment page",
      sourceType: "markdown",
      source: "# Comment page",
    });
    const thread = commentService.createThread({
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Needs review",
      authorUserId: uniqueId("usr"),
      anchor: {
        selectedText: "Comment page",
        sourceStart: 0,
        sourceEnd: 12,
        prefixText: "",
        suffixText: "",
        contentHash: page.page.contentHash,
      },
    });

    const response = await DELETE({
      cookies: sessionCookies(session.id),
      params: { threadId: thread.thread.id },
      url: new URL(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(403);
    expect(commentService.getThread(thread.thread.id)).not.toBeNull();
  });

  it("creates HTML text selection comments with quote selectors", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "HTML Text Comment Test",
    });
    const commenter = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `html-text-${crypto.randomUUID()}@example.com`,
      displayName: "HTML Reviewer",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: commenter.id,
      role: "commenter",
    });
    const session = authService.createSession(commenter.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "HTML page",
      sourceType: "html",
      source: "<main><p>Inline HTML review text lives here.</p></main>",
    });
    const url = `https://pages.example.test/api/pages/${page.page.id}/comments?workspace_id=${workspace.id}`;

    const response = await createComment({
      cookies: sessionCookies(session.id),
      params: { pageId: page.page.id },
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
            content_hash: page.page.contentHash,
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
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Comment Anchor Test",
    });
    const commenter = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `anchor-${crypto.randomUUID()}@example.com`,
      displayName: "Anchor Reviewer",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: commenter.id,
      role: "commenter",
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Anchor page",
      sourceType: "markdown",
      source: "# Anchor page",
    });
    const thread = commentService.createThread({
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Move this",
      authorUserId: commenter.id,
      anchor: {
        selectedText: "Pinned comment",
        sourceStart: null,
        sourceEnd: null,
        prefixText: "",
        suffixText: "",
        contentHash: page.page.contentHash,
        kind: "point",
        surface: "prose",
        selector: {
          point: { x: 0.1, y: 0.1, coordinateSpace: "document" },
        },
        confidence: "manual",
      },
    });

    const response = await updateAnchor({
      cookies: sessionCookies(authService.createSession(commenter.id).id),
      params: { threadId: thread.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/anchor?workspace_id=${workspace.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anchor: {
              selected_text: "Pinned comment",
              anchor_kind: "point",
              surface: "prose",
              content_hash: page.page.contentHash,
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
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/anchor?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(200);
    const updated = commentService.getThread(thread.thread.id)?.anchor;
    expect(updated?.selector?.point?.x).toBe(0.45);
    expect(updated?.selector?.point?.y).toBe(0.55);
    expect(updated?.selector?.point?.coordinateSpace).toBe("element");
    expect(updated?.selector?.documentPoint?.x).toBe(1);
    expect(updated?.selector?.documentPoint?.y).toBe(0);
    expect(updated?.selector?.element?.tag).toBe("h1");
    expect(updated?.selector?.textHit?.exact).toBe("Hero");
    expect(updated?.selector?.nearbyText).toBe("Hero headline");
    expect(updated?.confidence).toBe("manual");
  });

  it("rejects malformed anchor updates", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Comment Anchor Invalid Test",
    });
    const commenter = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `anchor-invalid-${crypto.randomUUID()}@example.com`,
      displayName: "Anchor Reviewer",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: commenter.id,
      role: "commenter",
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Anchor page",
      sourceType: "markdown",
      source: "# Anchor page",
    });
    const thread = commentService.createThread({
      pageId: page.page.id,
      workspaceId: workspace.id,
      body: "Move this",
      authorUserId: commenter.id,
      anchor: {
        selectedText: "Pinned comment",
        sourceStart: null,
        sourceEnd: null,
        prefixText: "",
        suffixText: "",
        contentHash: page.page.contentHash,
        kind: "point",
        surface: "prose",
        selector: {
          point: { x: 0.1, y: 0.1, coordinateSpace: "document" },
        },
        confidence: "manual",
      },
    });

    const response = await updateAnchor({
      cookies: sessionCookies(authService.createSession(commenter.id).id),
      params: { threadId: thread.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/anchor?workspace_id=${workspace.id}`,
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
        `https://pages.example.test/api/comment-threads/${thread.thread.id}/anchor?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(response.status).toBe(400);
  });
});
