import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  auth,
  pages as pagesService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { GET } from "../[attachmentId]";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-attachment-"));
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

describe("attachment API", () => {
  it("serves SVG attachments as downloads instead of inline documents", async () => {
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const owner = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `attachment-owner-${crypto.randomUUID()}@example.com`,
      displayName: "Attachment Owner",
      role: "user",
    });
    const reader = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `attachment-${crypto.randomUUID()}@example.com`,
      displayName: "Attachment Reader",
      role: "user",
    });
    const workspace = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: "Attachment Test",
      slug: uniqueId("slug"),
      firstAdminUserId: owner.id,
    });
    await workspaces.addMember(seedCtx, {
      workspaceId: workspace.id,
      userId: reader.id,
      role: "reader",
    });
    const session = await auth.createSession(seedCtx, { userId: reader.id });
    const { ctx: ownerCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      workspaceId: workspace.id,
    });
    ownerCtx.actor.userId = owner.id;
    ownerCtx.actor.email = owner.email;
    const created = await pagesService.create(ownerCtx, {
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Attachment page",
      sourceType: "markdown",
      source: "# Attachment page",
    });
    const page = created.data.page;
    const rawSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const body = btoa(rawSvg);
    const attachment = await attachments.upload(ownerCtx, {
      workspaceId: workspace.id,
      pageId: page.id,
      filename: "chart.svg",
      contentType: "image/svg+xml",
      body,
      byteSize: rawSvg.length,
    });

    const response = await GET({
      cookies: sessionCookies(session.id),
      params: { attachmentId: attachment.id },
      url: new URL(
        `https://pages.example.test/api/attachments/${attachment.id}?workspace_id=${workspace.id}`,
      ),
    } as never);

    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
  });
});
