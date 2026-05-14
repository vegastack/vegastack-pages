import { afterEach, describe, expect, it } from "vitest";
import {
  auditService,
  authService,
  pageService,
  workspaceService,
} from "../../../../lib/runtime";
import { GET } from "../[workspaceId]/export";

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

async function createAdminWorkspace(name = "Export Workspace") {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `${name} ${crypto.randomUUID()}`,
  });
  const admin = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `export-${crypto.randomUUID()}@example.test`,
    displayName: "Export Admin",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: admin.id,
    role: "admin",
  });
  return {
    workspace,
    cookies: sessionCookies(authService.createSession(admin.id).id),
  };
}

afterEach(() => {
  delete process.env.VPG_WORKSPACE_EXPORT_MAX_BYTES;
});

describe("workspace export API", () => {
  it("refuses exports that exceed the configured uncompressed size cap", async () => {
    process.env.VPG_WORKSPACE_EXPORT_MAX_BYTES = "512";
    const { workspace, cookies } = await createAdminWorkspace("Export Cap");
    await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Large export page",
      sourceType: "markdown",
      source: `# Large\n\n${"x".repeat(2048)}`,
    });

    const response = await GET({
      cookies,
      params: { workspaceId: workspace.id },
    } as never);
    const body = (await response.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };

    expect(response.status).toBe(413);
    expect(body.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(body.error?.details?.max_export_bytes).toBe(512);
  });

  it("streams successful exports, rate-limits repeat exports, and records audit logs", async () => {
    const { workspace, cookies } = await createAdminWorkspace("Export Stream");
    await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Exported page",
      sourceType: "markdown",
      source: "# Exported page",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await GET({
        cookies,
        params: { workspaceId: workspace.id },
      } as never);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/zip");
      expect(response.headers.has("Content-Length")).toBe(false);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }

    const limited = await GET({
      cookies,
      params: { workspaceId: workspace.id },
    } as never);
    expect(limited.status).toBe(429);
    expect(
      auditService
        .list({ workspaceId: workspace.id })
        .filter((log) => log.action === "workspace.exported"),
    ).toHaveLength(3);
  });
});
