import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  listMcpSessions,
  permissionService,
  revokeMcpSession,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

function adminCount(workspaceId: string) {
  return workspaceService
    .listMembers(workspaceId)
    .filter((member) => member.role === "admin").length;
}

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const workspace = workspaceService.getWorkspace(workspaceId);
    if (!workspace)
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
        { parameter: "workspaceId", location: "path" },
      );

    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Sign in to leave a workspace.", 401);
    }
    const member = workspaceService.getMember(workspaceId, actor.user.id);
    if (!member) {
      throw new AppError(
        "AUTH_REQUIRED",
        "You are not a member of this workspace.",
        404,
      );
    }
    if (member.role === "admin" && adminCount(workspaceId) <= 1) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Promote another admin before leaving — a workspace must keep at least one admin.",
        400,
      );
    }

    const removedGrants = permissionService.deleteGrantsForSubject({
      workspaceId,
      subjectId: actor.user.id,
    });
    const mcpSessions = await listMcpSessions({
      workspaceId,
      userId: actor.user.id,
    });
    for (const session of mcpSessions) {
      await revokeMcpSession({ workspaceId, sessionId: session.id });
    }
    const removed = workspaceService.removeMember(member.id);
    auditService.record({
      workspaceId,
      actorUserId: actor.user.id,
      action: "workspace.member_left",
      targetType: "member",
      targetId: removed.id,
      metadata: {
        user_id: removed.userId,
        role: removed.role,
        removed_grants: removedGrants.length,
        revoked_mcp_sessions: mcpSessions.length,
      },
    });
    return Response.json({
      member: { ...removed, user: workspaceService.getUser(removed.userId) },
      removed_grants: removedGrants.length,
      revoked_mcp_sessions: mcpSessions.length,
    });
  } catch (error) {
    return jsonAppError(error, "Leaving workspace failed.");
  }
};
