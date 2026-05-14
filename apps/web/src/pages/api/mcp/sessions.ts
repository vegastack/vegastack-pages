import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../lib/access";
import {
  auditService,
  checkRateLimit,
  createMcpSession,
  ensureSeedData,
  listMcpSessions,
  permissionService,
  revokeMcpSession,
  workspaceService,
} from "../../../lib/runtime";

export const prerender = false;

type RequestActor = Awaited<ReturnType<typeof getApiRequestActor>>;
type AuthenticatedActor = RequestActor & {
  user: NonNullable<RequestActor["user"]>;
};

function requireWorkspaceId(
  value: string,
  location: "query" | "body",
  hint: string,
) {
  const workspaceId = value.trim();
  if (!workspaceId) {
    throw new AppError(
      "WORKSPACE_REQUIRED",
      "workspace_id is required for this API request.",
      400,
      {
        parameter: "workspace_id",
        location,
        hint,
      },
    );
  }
  return workspaceId;
}

async function assertWorkspaceAdmin(
  cookies: Parameters<APIRoute>[0]["cookies"],
  request: Request,
  workspaceId: string,
) {
  await ensureSeedData();
  const actor = await getApiRequestActor(cookies, request);
  if (!actor.user || actor.devFallback || actor.authMode !== "session") {
    throw new AppError(
      "AUTH_REQUIRED",
      "Log in before managing MCP sessions.",
      401,
    );
  }
  const member = workspaceService.getMember(workspaceId, actor.user.id);
  const permission =
    actor.workspaceId && actor.workspaceId !== workspaceId
      ? "none"
      : permissionService.resolve({
          user: actor.user,
          member,
          workspaceId,
        });
  permissionService.assert({ actual: permission, required: "admin" });
  return actor as AuthenticatedActor;
}

async function assertWorkspaceMember(
  cookies: Parameters<APIRoute>[0]["cookies"],
  request: Request,
  workspaceId: string,
) {
  await ensureSeedData();
  const actor = await getApiRequestActor(cookies, request);
  if (!actor.user || actor.devFallback || actor.authMode !== "session") {
    throw new AppError(
      "AUTH_REQUIRED",
      "Log in before viewing your sessions.",
      401,
    );
  }
  const member = workspaceService.getMember(workspaceId, actor.user.id);
  const permission =
    actor.workspaceId && actor.workspaceId !== workspaceId
      ? "none"
      : permissionService.resolve({
          user: actor.user,
          member,
          workspaceId,
        });
  if (permission === "none") {
    throw new AppError(
      "PERMISSION_DENIED",
      "You are not a member of this workspace.",
      403,
    );
  }
  return {
    actor: actor as AuthenticatedActor,
    permission,
  };
}

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    const workspaceId = requireWorkspaceId(
      url.searchParams.get("workspace_id") ?? "",
      "query",
      "Pass workspace_id when listing MCP sessions.",
    );
    const view = (url.searchParams.get("view") ?? "mine").toLowerCase();
    if (view === "workspace") {
      await assertWorkspaceAdmin(cookies, request, workspaceId);
      const sessions = await listMcpSessions({ workspaceId });
      return Response.json({ sessions, view: "workspace" });
    }
    const { actor } = await assertWorkspaceMember(
      cookies,
      request,
      workspaceId,
    );
    const sessions = await listMcpSessions({
      workspaceId,
      userId: actor.user.id,
    });
    return Response.json({ sessions, view: "mine" });
  } catch (error) {
    return jsonAppError(error, "Could not list MCP sessions.");
  }
};

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    const body = await request.json();
    const workspaceId = requireWorkspaceId(
      String(body.workspace_id ?? ""),
      "body",
      "Pass workspace_id when creating an MCP session.",
    );
    const { actor } = await assertWorkspaceMember(
      cookies,
      request,
      workspaceId,
    );
    await checkRateLimit({
      key: `mcp-session:${actor.user.id}:${workspaceId}`,
      limit: 10,
      windowMs: 60 * 60_000,
    });
    const created = await createMcpSession({
      workspaceId,
      userId: actor.user.id,
      clientName: body.client_name ? String(body.client_name) : "MCP client",
      protocolVersion: body.protocol_version
        ? String(body.protocol_version)
        : null,
      kind: "manual",
    });
    const { session, rawToken } = created;
    auditService.record({
      workspaceId,
      actorUserId: actor.user.id,
      action: "mcp_session.created",
      targetType: "mcp_session",
      targetId: session.id,
      metadata: {
        client_name: session.clientName,
        expires_at: session.expiresAt,
      },
    });
    return Response.json({
      token: rawToken,
      session_id: session.id,
      workspace_id: session.workspaceId,
      expires_at: session.expiresAt,
      mcp_url: `${url.origin}/mcp`,
      authorization_header: `Bearer ${rawToken}`,
    });
  } catch (error) {
    return jsonAppError(error, "Could not create MCP session.");
  }
};

export const DELETE: APIRoute = async ({ cookies, request }) => {
  try {
    const body = await request.json();
    const workspaceId = requireWorkspaceId(
      String(body.workspace_id ?? ""),
      "body",
      "Pass workspace_id when revoking an MCP session.",
    );
    const sessionId = String(body.session_id ?? "");
    if (!sessionId) {
      throw new AppError("VALIDATION_ERROR", "session_id is required.", 400, {
        parameter: "session_id",
        location: "body",
        hint: "Pass the MCP session_id returned when the session was created.",
      });
    }
    const { actor, permission } = await assertWorkspaceMember(
      cookies,
      request,
      workspaceId,
    );
    const ownedSessions = await listMcpSessions({
      workspaceId,
      userId: actor.user.id,
    });
    const owned = ownedSessions.some((session) => session.id === sessionId);
    if (!owned && permission !== "admin") {
      throw new AppError(
        "PERMISSION_DENIED",
        "You can only revoke your own sessions.",
        403,
      );
    }
    const revoked = await revokeMcpSession({ workspaceId, sessionId });
    if (!revoked)
      throw new AppError(
        "MCP_SESSION_NOT_FOUND",
        "MCP session not found.",
        404,
      );
    auditService.record({
      workspaceId,
      actorUserId: actor.user.id,
      action: "mcp_session.revoked",
      targetType: "mcp_session",
      targetId: sessionId,
      metadata: { self: owned },
    });
    return Response.json({ status: "ok" });
  } catch (error) {
    return jsonAppError(error, "Could not revoke MCP session.");
  }
};
