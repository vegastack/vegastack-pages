import { AppError, type WorkspaceRole } from "@vegastack/pages-core";
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
import { getApiRequestActor } from "../../../../../lib/access";
import { listMcpSessions, revokeMcpSession } from "../../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../../lib/workspace-navigation";

export const prerender = false;
const workspaceRoles = ["reader", "commenter", "editor", "admin"] as const;

type Member = NonNullable<
  Awaited<ReturnType<typeof workspacesService.getMemberById>>
>;

async function assertWorkspaceAdmin(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  workspaceId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
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
    throw new AppError("WORKSPACE_NOT_FOUND", "Workspace was not found.", 404, {
      parameter: "workspaceId",
      location: "path",
    });
  const member = actor.user
    ? await workspacesService.getMember(ctx, {
        workspaceId,
        userId: actor.user.id,
      })
    : null;
  const permission =
    actor.workspaceId && actor.workspaceId !== workspaceId
      ? "none"
      : await permissions.resolve(ctx, {
          workspaceId,
          userId: actor.user?.id ?? "",
          scope: "workspace",
          targetId: workspaceId,
          memberRole: member?.role ?? null,
          instanceRole: actor.user?.role,
        });
  permissions.assertLevel({ actual: permission, required: "admin" });
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

async function serializeMember(
  ctx: ServiceContext,
  member: Member | null | undefined,
) {
  if (!member) return null;
  return { ...member, user: await users.getById(ctx, member.userId) };
}

async function adminCount(ctx: ServiceContext, workspaceId: string) {
  const members = await workspacesService.listMembers(ctx, { workspaceId });
  return members.filter((member) => member.role === "admin").length;
}

async function assertCanChangeMember(input: {
  ctx: ServiceContext;
  actorUserId: string | null | undefined;
  workspaceId: string;
  target: Member;
  nextRole?: WorkspaceRole;
  action: "update" | "remove";
}) {
  if (input.target.userId === input.actorUserId) {
    if (input.action === "remove") {
      throw new AppError(
        "VALIDATION_ERROR",
        "You cannot remove yourself from the workspace.",
        400,
      );
    }
    if (input.nextRole !== input.target.role) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Use another workspace admin to change your own role.",
        400,
      );
    }
    return;
  }

  const removesAdmin =
    input.target.role === "admin" &&
    (input.action === "remove" || input.nextRole !== "admin");
  if (removesAdmin && (await adminCount(input.ctx, input.workspaceId)) <= 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A workspace must keep at least one admin.",
      400,
    );
  }
}

async function resolveActorForUpdate(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  workspaceId: string,
  target: Member,
  nextRole: WorkspaceRole,
) {
  const actor = await getApiRequestActor(cookies, request);
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
    throw new AppError("WORKSPACE_NOT_FOUND", "Workspace was not found.", 404, {
      parameter: "workspaceId",
      location: "path",
    });
  // Self-edits that don't change role are allowed for any workspace member —
  // editing your own display name is a profile change, not a privileged action.
  const isSelfNameOnly =
    target.userId === actor.user?.id && nextRole === target.role;
  if (isSelfNameOnly) return actor;

  const member = actor.user
    ? await workspacesService.getMember(ctx, {
        workspaceId,
        userId: actor.user.id,
      })
    : null;
  const permission =
    actor.workspaceId && actor.workspaceId !== workspaceId
      ? "none"
      : await permissions.resolve(ctx, {
          workspaceId,
          userId: actor.user?.id ?? "",
          scope: "workspace",
          targetId: workspaceId,
          memberRole: member?.role ?? null,
          instanceRole: actor.user?.role,
        });
  permissions.assertLevel({ actual: permission, required: "admin" });
  return actor;
}

export const PATCH: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const target = await workspacesService.getMemberById(
      ctx,
      params.memberId ?? "",
    );
    if (!target || target.workspaceId !== workspaceId) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Workspace member was not found.",
        404,
      );
    }
    const body = await request.json();
    const role = coerceRole(body.role);
    const actor = await resolveActorForUpdate(
      cookies,
      request,
      workspaceId,
      target,
      role,
    );
    await assertCanChangeMember({
      ctx,
      actorUserId: actor.user?.id,
      workspaceId,
      target,
      nextRole: role,
      action: "update",
    });
    const updatedUser =
      body.display_name === undefined
        ? await users.getById(ctx, target.userId)
        : await users.setDisplayName(ctx, {
            userId: target.userId,
            displayName: String(body.display_name ?? ""),
          });
    const updated = await workspacesService.updateMemberRole(ctx, {
      memberId: target.id,
      role,
    });
    const member = updated.data;
    await audit.record(ctx, {
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
    const treeVersion = (await buildWorkspaceNavigation(actor, workspaceId))
      .treeVersion;
    return jsonWithEnvelope(
      { member: await serializeMember(ctx, member) },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`members:${workspaceId}`, `member:${member.id}`],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace member update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertWorkspaceAdmin(cookies, request, workspaceId);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const target = await workspacesService.getMemberById(
      ctx,
      params.memberId ?? "",
    );
    if (!target || target.workspaceId !== workspaceId) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Workspace member was not found.",
        404,
      );
    }
    await assertCanChangeMember({
      ctx,
      actorUserId: actor.user?.id,
      workspaceId,
      target,
      action: "remove",
    });
    const removedGrants = await permissions.deleteGrantsForSubject(ctx, {
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
    const removed = await workspacesService.removeMember(ctx, {
      memberId: target.id,
    });
    const member = removed.data;
    await audit.record(ctx, {
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "workspace.member_removed",
      targetType: "member",
      targetId: member.id,
      metadata: {
        user_id: member.userId,
        role: member.role,
        removed_grants: removedGrants.removed,
        revoked_mcp_sessions: mcpSessions.length,
      },
    });
    const treeVersion = (await buildWorkspaceNavigation(actor, workspaceId))
      .treeVersion;
    return jsonWithEnvelope(
      {
        member: await serializeMember(ctx, member),
        removed_grants: removedGrants.removed,
        revoked_mcp_sessions: mcpSessions.length,
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`members:${workspaceId}`, `member:${member.id}`],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace member removal failed.");
  }
};
