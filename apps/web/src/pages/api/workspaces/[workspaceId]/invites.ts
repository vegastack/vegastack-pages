import { AppError } from "@vegastack/pages-core";
import type { WorkspaceRole } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import { sendMagicLinkEmail } from "../../../../lib/email";
import { magicLinkHandoffUrl } from "../../../../lib/magic-link";
import {
  auditService,
  authService,
  ensureSeedData,
  permissionService,
  workspaceService,
} from "../../../../lib/runtime";

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

function adminCount(workspaceId: string) {
  return workspaceService
    .listMembers(workspaceId)
    .filter((member) => member.role === "admin").length;
}

function assertCanUpsertMember(input: {
  actorUserId: string | null | undefined;
  workspaceId: string;
  existingMember: ReturnType<typeof workspaceService.getMember>;
  nextRole: WorkspaceRole;
}) {
  if (!input.existingMember) return;
  if (
    input.existingMember.userId === input.actorUserId &&
    input.existingMember.role !== input.nextRole
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Use another workspace admin to change your own role.",
      400,
    );
  }
  if (
    input.existingMember.role === "admin" &&
    input.nextRole !== "admin" &&
    adminCount(input.workspaceId) <= 1
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A workspace must keep at least one admin.",
      400,
    );
  }
}

function serializeMember(
  member: ReturnType<typeof workspaceService.getMember>,
) {
  if (!member) return null;
  return { ...member, user: workspaceService.getUser(member.userId) };
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    await assertWorkspaceAdmin(cookies, request, workspaceId);
    const members = workspaceService.listMembers(workspaceId).map((member) => ({
      ...member,
      user: workspaceService.getUser(member.userId),
    }));
    return Response.json({ members });
  } catch (error) {
    return jsonAppError(error, "Workspace invite listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertWorkspaceAdmin(cookies, request, workspaceId);
    if (!workspaceService.getWorkspace(workspaceId)) {
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
        {
          parameter: "workspaceId",
          location: "path",
        },
      );
    }
    const body = await request.json();
    const role = coerceRole(body.role ?? "reader");
    const requestedDisplayName = String(body.display_name ?? "").trim();
    const createdUser = workspaceService.createUser({
      email: String(body.email ?? ""),
      displayName: requestedDisplayName || String(body.email ?? ""),
      role: "user",
    });
    const user = requestedDisplayName
      ? workspaceService.updateUser({
          userId: createdUser.id,
          displayName: requestedDisplayName,
        })
      : createdUser;
    const existingMember = workspaceService.getMember(workspaceId, user.id);
    assertCanUpsertMember({
      actorUserId: actor.user?.id,
      workspaceId,
      existingMember,
      nextRole: role,
    });
    const member = workspaceService.addMember({
      workspaceId,
      userId: user.id,
      role,
    });
    const magic =
      body.send_magic_link === false
        ? null
        : await authService.createMagicLink({
            email: user.email,
            redirectTo: body.redirect_to ? String(body.redirect_to) : "/app",
          });
    const workspace = workspaceService.getWorkspace(workspaceId);
    const verifyUrl = magic
      ? magicLinkHandoffUrl(url.origin, magic.rawToken)
      : null;
    let delivery = null;
    let manualVerifyUrl = null;
    let deliveryWarning = null;
    if (magic) {
      try {
        delivery = await sendMagicLinkEmail({
          to: user.email,
          verifyUrl: verifyUrl!,
          workspaceName: workspace?.name ?? null,
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "EMAIL_NOT_CONFIGURED"
        ) {
          manualVerifyUrl = verifyUrl;
          delivery = { provider: "manual", sent: false };
          deliveryWarning =
            "Email is not configured. Copy the one-time sign-in link and send it manually.";
        } else {
          throw error;
        }
      }
    }

    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: existingMember
        ? "workspace.member_reinvited"
        : "workspace.member_invited",
      targetType: "user",
      targetId: user.id,
      metadata: {
        role,
        email: user.email,
        existing_member: Boolean(existingMember),
        delivery_warning: deliveryWarning,
      },
    });

    const response: Record<string, unknown> = {
      user,
      member: serializeMember(member),
      magic_link_created: Boolean(magic),
      delivery,
      delivery_warning: deliveryWarning,
      manual_verify_url: manualVerifyUrl,
      existing_member: Boolean(existingMember),
    };
    if (magic && import.meta.env.DEV) {
      response.debug_verify_url = verifyUrl;
    }
    return Response.json(response);
  } catch (error) {
    return jsonAppError(error, "Workspace invite failed.");
  }
};
