import { describe, expect, it, vi } from "vitest";
import {
  pageService,
  publicationService,
  workspaceService,
} from "../../../../lib/runtime";
import { POST as createComment } from "../../pages/[pageId]/comments";
import { POST as createReply } from "../[threadId]/replies";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function mutableCookies() {
  const values = new Map<string, string>();
  return {
    get(name: string) {
      const value = values.get(name);
      return value ? { value } : undefined;
    },
    set: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
  };
}

describe("guest comment sessions", () => {
  it("binds guest replies to the first signed guest session name for a publication", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Guest Comments ${crypto.randomUUID()}`,
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Guest comments",
      sourceType: "markdown",
      source: "# Guest comments",
    });
    await publicationService.upsert({
      resourceType: "page",
      resourceId: page.page.id,
      workspaceId: workspace.id,
      permission: "comment",
    });
    const cookies = mutableCookies();
    const pageUrl = new URL(`https://pages.example.test/p/${page.page.slugId}`);

    const createdResponse = await createComment({
      cookies: cookies as never,
      params: { pageId: page.page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.page.id}/comments?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: "First comment",
            guest_name: "Alice",
            anchor: {
              selected_text: "Guest",
              source_start: 2,
              source_end: 7,
              content_hash: page.page.contentHash,
            },
          }),
        },
      ),
      url: pageUrl,
    } as never);
    const created = (await createdResponse.json()) as {
      thread: { id: string; guestName: string; guestSessionId: string };
      replies: Array<{ guestName: string; guestSessionId: string }>;
    };

    expect(createdResponse.status).toBe(200);
    expect(created.thread.guestName).toBe("Alice");
    expect(created.thread.guestSessionId).toMatch(/^gst_/);
    expect(cookies.set).toHaveBeenCalledWith(
      expect.stringMatching(/^vpg_guest_/),
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
    );

    const replyResponse = await createReply({
      cookies: cookies as never,
      params: { threadId: created.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${created.thread.id}/replies?workspace_id=${workspace.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: "Trying another name",
            guest_name: "Mallory",
          }),
        },
      ),
      url: pageUrl,
    } as never);
    const replied = (await replyResponse.json()) as {
      reply: { guestName: string; guestSessionId: string };
    };

    expect(replyResponse.status).toBe(200);
    expect(replied.reply.guestName).toBe("Alice");
    expect(replied.reply.guestSessionId).toBe(created.thread.guestSessionId);
  });
});
