import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  buildEnvelope,
  jsonWithEnvelope,
  permissions,
  users,
  workspaces as workspacesService,
  type ServiceContext,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import { listMcpSessions, revokeMcpSession } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function adminCount(ctx: ServiceContext, workspaceId: string) {
  const members = await workspacesService.listMembers(ctx, { workspaceId });
  return members.filter((member) => member.role === "admin").length;
}

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    let workspace;
    try {
      workspace = await workspacesService.get(ctx, { workspaceId });
    } catch {
      workspace = null;
    }
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
    const member = await workspacesService.getMember(ctx, {
      workspaceId,
      userId: actor.user.id,
    });
    if (!member) {
      throw new AppError(
        "AUTH_REQUIRED",
        "You are not a member of this workspace.",
        404,
      );
    }
    if (member.role === "admin" && (await adminCount(ctx, workspaceId)) <= 1) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Promote another admin before leaving — a workspace must keep at least one admin.",
        400,
      );
    }

    const removedGrants = await permissions.deleteGrantsForSubject(ctx, {
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
    const removedResult = await workspacesService.removeMember(ctx, {
      memberId: member.id,
    });
    const removed = removedResult.data;
    await audit.record(ctx, {
      workspaceId,
      actorUserId: actor.user.id,
      action: "workspace.member_left",
      targetType: "member",
      targetId: removed.id,
      metadata: {
        user_id: removed.userId,
        role: removed.role,
        removed_grants: removedGrants.removed,
        revoked_mcp_sessions: mcpSessions.length,
      },
    });
    // Compute tree_version against the actor's now-empty membership. This
    // signals to any other tabs that the workspace tree should be refetched
    // (and will likely 403, prompting a workspace switch).
    const treeVersion = (await buildWorkspaceNavigation(actor, workspaceId))
      .treeVersion;
    return jsonWithEnvelope(
      {
        member: { ...removed, user: await users.getById(ctx, removed.userId) },
        removed_grants: removedGrants.removed,
        revoked_mcp_sessions: mcpSessions.length,
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`members:${workspaceId}`, `member:${removed.id}`],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Leaving workspace failed.");
  }
};
