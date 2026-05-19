import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  audit,
  auth,
  pages as pagesService,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { GET } from "../[workspaceId]/export";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-export-"));
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

async function createAdminWorkspace(name = "Export Workspace") {
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const admin = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `export-${crypto.randomUUID()}@example.test`,
    displayName: "Export Admin",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `${name} ${crypto.randomUUID()}`,
    slug: uniqueId("slug"),
    firstAdminUserId: admin.id,
  });
  const session = await auth.createSession(seedCtx, { userId: admin.id });
  const { ctx: actorCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    workspaceId: workspace.id,
  });
  actorCtx.actor.userId = admin.id;
  actorCtx.actor.email = admin.email;
  return {
    workspace,
    admin,
    actorCtx,
    cookies: sessionCookies(session.id),
  };
}

afterEach(() => {
  delete process.env.VPG_WORKSPACE_EXPORT_MAX_BYTES;
});

describe("workspace export API", () => {
  it("refuses exports that exceed the configured uncompressed size cap", async () => {
    process.env.VPG_WORKSPACE_EXPORT_MAX_BYTES = "512";
    const { workspace, cookies, actorCtx } =
      await createAdminWorkspace("Export Cap");
    await pagesService.create(actorCtx, {
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
    const { workspace, cookies, actorCtx } =
      await createAdminWorkspace("Export Stream");
    await pagesService.create(actorCtx, {
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
    const logs = await audit.list(actorCtx, { workspaceId: workspace.id });
    expect(
      logs.filter((log) => log.action === "workspace.exported"),
    ).toHaveLength(3);
  });
});
