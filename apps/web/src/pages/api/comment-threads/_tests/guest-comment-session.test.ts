import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  pages,
  publications,
  workspaces,
  users,
  auth,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { POST as createComment } from "../../pages/[pageId]/comments";
import { POST as createReply } from "../[threadId]/replies";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-guest-"));
});

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function emptySeedCookies() {
  return { get: () => undefined } as never;
}

function sessionCookies(sessionId: string) {
  return {
    get(name: string) {
      return name === "vpg_session" ? { value: sessionId } : undefined;
    },
  } as never;
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
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: emptySeedCookies(),
    });
    // We need an authenticated creator so pages.create stamps
    // created_by — workspaces.create with firstAdminUserId would do
    // too, but the page needs an actor to attribute the version.
    const owner = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `guest-owner-${crypto.randomUUID()}@example.test`,
      displayName: "Guest Owner",
    });
    const workspace = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: `Guest Comments ${crypto.randomUUID()}`,
      slug: uniqueId("slug"),
      firstAdminUserId: owner.id,
    });
    const ownerSession = await auth.createSession(seedCtx, {
      userId: owner.id,
    });
    const { ctx: ownerCtx } = await buildServiceContext({
      cookies: sessionCookies(ownerSession.id),
      workspaceId: workspace.id,
    });
    const created = await pages.create(ownerCtx, {
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Guest comments",
      sourceType: "markdown",
      source: "# Guest comments",
    });
    await publications.upsert(seedCtx, {
      resourceType: "page",
      resourceId: created.data.page.id,
      workspaceId: workspace.id,
      permission: "comment",
    });

    const page = created.data.page;
    const cookies = mutableCookies();
    const pageUrl = new URL(`https://pages.example.test/p/${page.slugId}`);

    const createdResponse = await createComment({
      cookies: cookies as never,
      params: { pageId: page.id },
      request: new Request(
        `https://pages.example.test/api/pages/${page.id}/comments?workspace_id=${workspace.id}`,
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
              content_hash: page.contentHash,
            },
          }),
        },
      ),
      url: pageUrl,
    } as never);
    const createdBody = (await createdResponse.json()) as {
      thread: { id: string; guestName: string; guestSessionId: string };
      replies: Array<{ guestName: string; guestSessionId: string }>;
    };

    expect(createdResponse.status).toBe(200);
    expect(createdBody.thread.guestName).toBe("Alice");
    expect(createdBody.thread.guestSessionId).toMatch(/^gst_/);
    expect(cookies.set).toHaveBeenCalledWith(
      expect.stringMatching(/^vpg_guest_/),
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
    );

    // The replies route still consults the legacy in-memory
    // commentService.getThread for the lookup; sync from D1 first.

    const replyResponse = await createReply({
      cookies: cookies as never,
      params: { threadId: createdBody.thread.id },
      request: new Request(
        `https://pages.example.test/api/comment-threads/${createdBody.thread.id}/replies?workspace_id=${workspace.id}`,
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
    expect(replied.reply.guestSessionId).toBe(
      createdBody.thread.guestSessionId,
    );
  });
});
