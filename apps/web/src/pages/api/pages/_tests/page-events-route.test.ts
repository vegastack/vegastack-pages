import { describe, expect, it } from "vitest";
import {
  authService,
  pageService,
  workspaceService,
} from "../../../../lib/runtime";
import { POST as createComment } from "../[pageId]/comments";
import { GET as listEvents } from "../[pageId]/events";
import { GET as listReviewEvents } from "../../review-events";

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

describe("page review events API", () => {
  it("lists workspace-scoped review events through the standalone API", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Review Events ${crypto.randomUUID()}`,
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `review-events-${crypto.randomUUID()}@example.test`,
      displayName: "Review Events Admin",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: "admin",
    });
    const cookies = sessionCookies(authService.createSession(user.id).id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Workspace Review Events",
      sourceType: "markdown",
      source: "# Workspace Review Events",
    });

    await createComment({
      cookies,
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/comments?workspace_id=${workspace.id}`,
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
        `https://pages.example.test/api/pages/${page.page.id}/comments?workspace_id=${workspace.id}`,
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
    expect(body.events?.some((event) => event.pageId === page.page.id)).toBe(
      true,
    );
    expect(body.events?.some((event) => event.type === "comment.created")).toBe(
      true,
    );
  });

  it("does not expose comment bodies or selected text in event payloads", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Events ${crypto.randomUUID()}`,
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `events-${crypto.randomUUID()}@example.test`,
      displayName: "Events Admin",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: "admin",
    });
    const session = authService.createSession(user.id);
    const cookies = sessionCookies(session.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Events",
      sourceType: "markdown",
      source: "# Events",
    });

    await createComment({
      cookies,
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/comments?workspace_id=${workspace.id}`,
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
        `https://pages.example.test/api/pages/${page.page.id}/comments?workspace_id=${workspace.id}`,
      ),
    } as never);

    const response = await listEvents({
      cookies,
      params: { pageId: page.page.id },
      url: new URL(
        `https://pages.example.test/api/pages/${page.page.id}/events?workspace_id=${workspace.id}`,
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
