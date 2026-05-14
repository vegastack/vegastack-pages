import { afterEach, describe, expect, it } from "vitest";
import { POST as callMcp } from "../../../mcp";
import {
  authService,
  createMcpSession,
  workspaceService,
} from "../../../../lib/runtime";
import { DELETE, GET, POST } from "../sessions";

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

afterEach(() => {
  delete process.env.VPG_MCP_AUTH_REQUIRED;
});

describe("MCP sessions API", () => {
  it("returns an agent-readable error when workspace_id is missing", async () => {
    const response = await GET({
      cookies: { get: () => undefined } as never,
      url: new URL("https://pages.example.test/api/mcp/sessions"),
      request: new Request("https://pages.example.test/api/mcp/sessions"),
    } as never);
    const body = (await response.json()) as {
      error?: {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
    };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("WORKSPACE_REQUIRED");
    expect(body.error?.message).toBe(
      "workspace_id is required for this API request.",
    );
    expect(body.error?.details?.parameter).toBe("workspace_id");
  });

  it("does not let a workspace bearer token mint or list MCP sessions", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "MCP Session Token Escalation",
    });
    const admin = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `mcp-session-token-${crypto.randomUUID()}@example.com`,
      displayName: "MCP Token Admin",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: admin.id,
      role: "admin",
    });
    const session = await createMcpSession({
      workspaceId: workspace.id,
      userId: admin.id,
      clientName: "existing token",
      protocolVersion: null,
    });

    const listed = await GET({
      cookies: { get: () => undefined } as never,
      url: new URL(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}`,
      ),
      request: new Request(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}`,
        {
          headers: { authorization: `Bearer ${session.rawToken}` },
        },
      ),
    } as never);
    expect(listed.status).toBe(401);

    const created = await POST({
      cookies: { get: () => undefined } as never,
      url: new URL("https://pages.example.test/api/mcp/sessions"),
      request: new Request("https://pages.example.test/api/mcp/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.rawToken}`,
        },
        body: JSON.stringify({
          workspace_id: workspace.id,
          client_name: "nested token",
        }),
      }),
    } as never);
    expect(created.status).toBe(401);
  });

  it("shows MCP bearer tokens only once at creation", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "MCP Session Hash",
    });
    const admin = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `mcp-session-admin-${crypto.randomUUID()}@example.com`,
      displayName: "MCP Session Admin",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: admin.id,
      role: "admin",
    });
    const cookies = sessionCookies(authService.createSession(admin.id).id);

    const createdResponse = await POST({
      cookies,
      url: new URL("https://pages.example.test/api/mcp/sessions"),
      request: new Request("https://pages.example.test/api/mcp/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          client_name: "Test client",
        }),
      }),
    } as never);
    const created = (await createdResponse.json()) as {
      token: string;
      session_id: string;
      authorization_header: string;
    };

    expect(createdResponse.status).toBe(200);
    expect(created.token).toMatch(/^mcp_/);
    expect(created.session_id).not.toBe(created.token);
    expect(created.authorization_header).toBe(`Bearer ${created.token}`);

    const listResponse = await GET({
      cookies,
      url: new URL(
        `https://pages.example.test/api/mcp/sessions?workspace_id=${workspace.id}`,
      ),
    } as never);
    const listBody = (await listResponse.json()) as {
      sessions: Array<{ id: string; clientName: string }>;
    };

    expect(listResponse.status).toBe(200);
    expect(JSON.stringify(listBody)).not.toContain(created.token);
    expect(listBody.sessions.map((session) => session.id)).toContain(
      created.session_id,
    );

    const initialized = await mcpInitialize(created.token);
    expect(initialized.status).toBe(200);

    const deleted = await DELETE({
      cookies,
      request: new Request("https://pages.example.test/api/mcp/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          session_id: created.session_id,
        }),
      }),
    } as never);
    expect(deleted.status).toBe(200);

    process.env.VPG_MCP_AUTH_REQUIRED = "true";
    const revoked = await mcpInitialize(created.token);
    expect(revoked.status).toBe(401);
  });
});

function mcpInitialize(token: string) {
  return callMcp({
    request: new Request("https://pages.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    }),
  } as never);
}
