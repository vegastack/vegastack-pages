import { AppError, type WorkspaceRole } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  listMcpSessions,
  permissionService,
  revokeMcpSession,
  workspaceService,
} from "../../../../../lib/runtime";

export const prerender = false;
const workspaceRoles = ["reader", "commenter", "editor", "admin"] as const;

async function assertWorkspaceAdmin(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  workspaceId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
  const workspace = workspaceService.getWorkspace(workspaceId);
  if (!workspace)
    throw new AppError("WORKSPACE_NOT_FOUND", "Workspace was not found.", 404, {
      parameter: "workspaceId",
      location: "path",
    });
  const member = actor.user
    ? workspaceService.getMember(workspaceId, actor.user.id)
    : null;
  const permission =
    actor.workspaceId && actor.workspaceId !== workspaceId
      ? "none"
      : permissionService.resolve({
          user: actor.user,
          member,
          workspaceId,
        });
  permissionService.assert({ actual: permission, required: "admin" });
  return actor;
}

function coerceRole(value: unknown): WorkspaceRole {
  if (workspaceRoles.includes(value as WorkspaceRole)) {
    return value as WorkspaceRole;
  }
  throw new AppError("VALIDATION_ERROR", "Unsupported workspace role.", 400, {
    allowed_roles: workspaceRoles,
  });
}

function serializeMember(
  member: ReturnType<typeof workspaceService.getMemberById>,
) {
  if (!member) return null;
  return { ...member, user: workspaceService.getUser(member.userId) };
}

function adminCount(workspaceId: string) {
  return workspaceService
    .listMembers(workspaceId)
    .filter((member) => member.role === "admin").length;
}

function assertCanChangeMember(input: {
  actorUserId: string | null | undefined;
  workspaceId: string;
  target: NonNullable<ReturnType<typeof workspaceService.getMemberById>>;
  nextRole?: WorkspaceRole;
  action: "update" | "remove";
}) {
  if (input.target.userId === input.actorUserId) {
    throw new AppError(
      "VALIDATION_ERROR",
      input.action === "remove"
        ? "You cannot remove yourself from the workspace."
        : "Use another workspace admin to change your own role.",
      400,
    );
  }

  const removesAdmin =
    input.target.role === "admin" &&
    (input.action === "remove" || input.nextRole !== "admin");
  if (removesAdmin && adminCount(input.workspaceId) <= 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A workspace must keep at least one admin.",
      400,
    );
  }
}

export const PATCH: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertWorkspaceAdmin(cookies, request, workspaceId);
    const target = workspaceService.getMemberById(params.memberId ?? "");
    if (!target || target.workspaceId !== workspaceId) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Workspace member was not found.",
        404,
      );
    }
    const body = await request.json();
    const role = coerceRole(body.role);
    assertCanChangeMember({
      actorUserId: actor.user?.id,
      workspaceId,
      target,
      nextRole: role,
      action: "update",
    });
    const updatedUser =
      body.display_name === undefined
        ? workspaceService.getUser(target.userId)
        : workspaceService.updateUser({
            userId: target.userId,
            displayName: String(body.display_name ?? ""),
          });
    const member = workspaceService.updateMemberRole({
      memberId: target.id,
      role,
    });
    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "workspace.member_role_updated",
      targetType: "member",
      targetId: member.id,
      metadata: {
        user_id: member.userId,
        role: member.role,
        display_name: updatedUser?.displayName ?? null,
      },
    });
    return Response.json({ member: serializeMember(member) });
  } catch (error) {
    return jsonAppError(error, "Workspace member update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertWorkspaceAdmin(cookies, request, workspaceId);
    const target = workspaceService.getMemberById(params.memberId ?? "");
    if (!target || target.workspaceId !== workspaceId) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Workspace member was not found.",
        404,
      );
    }
    assertCanChangeMember({
      actorUserId: actor.user?.id,
      workspaceId,
      target,
      action: "remove",
    });
    const removedGrants = permissionService.deleteGrantsForSubject({
      workspaceId,
      subjectId: target.userId,
    });
    const mcpSessions = await listMcpSessions({
      workspaceId,
      userId: target.userId,
    });
    for (const session of mcpSessions) {
      await revokeMcpSession({ workspaceId, sessionId: session.id });
    }
    const member = workspaceService.removeMember(target.id);
    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "workspace.member_removed",
      targetType: "member",
      targetId: member.id,
      metadata: {
        user_id: member.userId,
        role: member.role,
        removed_grants: removedGrants.length,
        revoked_mcp_sessions: mcpSessions.length,
      },
    });
    return Response.json({
      member: serializeMember(member),
      removed_grants: removedGrants.length,
      revoked_mcp_sessions: mcpSessions.length,
    });
  } catch (error) {
    return jsonAppError(error, "Workspace member removal failed.");
  }
};
