import { describe, expect, it } from "vitest";
import { GET } from "../[attachmentId]";
import {
  attachmentService,
  authService,
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

describe("attachment API", () => {
  it("serves SVG attachments as downloads instead of inline documents", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "Attachment Test",
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `attachment-${crypto.randomUUID()}@example.com`,
      displayName: "Attachment Reader",
      role: "user",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: "reader",
    });
    const session = authService.createSession(user.id);
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Attachment page",
      sourceType: "markdown",
      source: "# Attachment page",
    });
    const attachment = await attachmentService.upload({
      page: page.page,
      filename: "chart.svg",
      contentType: "image/svg+xml",
      base64Body: btoa(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
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
