import { AppError } from "@vegastack/pages-core";
import type { WorkspaceRole } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  auth,
  buildEnvelope,
  jsonWithEnvelope,
  permissions,
  rateLimit,
  users,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import { safeLocalRedirectPath } from "../../../../lib/auth-redirects";
import { sendMagicLinkEmail } from "../../../../lib/email";
import { magicLinkHandoffUrl } from "../../../../lib/magic-link";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;
const workspaceRoles = ["reader", "commenter", "editor", "admin"] as const;

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

async function adminCount(
  ctx: Parameters<typeof workspacesService.listMembers>[0],
  workspaceId: string,
) {
  const members = await workspacesService.listMembers(ctx, { workspaceId });
  return members.filter((member) => member.role === "admin").length;
}

async function assertCanUpsertMember(input: {
  ctx: Parameters<typeof workspacesService.listMembers>[0];
  actorUserId: string | null | undefined;
  workspaceId: string;
  existingMember: Awaited<ReturnType<typeof workspacesService.getMember>>;
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
    (await adminCount(input.ctx, input.workspaceId)) <= 1
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A workspace must keep at least one admin.",
      400,
    );
  }
}

async function serializeMember(
  ctx: Parameters<typeof users.getById>[0],
  member: Awaited<ReturnType<typeof workspacesService.getMember>>,
) {
  if (!member) return null;
  const user = await users.getById(ctx, member.userId);
  return { ...member, user };
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    await assertWorkspaceAdmin(cookies, request, workspaceId);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const membersList = await workspacesService.listMembers(ctx, {
      workspaceId,
    });
    const members = await Promise.all(
      membersList.map(async (member) => ({
        ...member,
        user: await users.getById(ctx, member.userId),
      })),
    );
    return Response.json({ members });
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace invite listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertWorkspaceAdmin(cookies, request, workspaceId);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    // Anti-abuse: invite-email throttle scoped to (admin, workspace).
    // 30 invites per workspace per admin per hour — generous for legit
    // onboarding bursts, tight enough to prevent a compromised admin
    // session from spam-emailing arbitrary addresses.
    const rl = await rateLimit.check(ctx, {
      key: `invite:${actor.user?.id ?? "anon"}:${workspaceId}`,
      limit: 30,
      windowMs: 60 * 60_000,
    });
    if (!rl.ok) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests. Try again later.",
        429,
        { reset_at: rl.resetAt },
      );
    }
    let workspace;
    try {
      workspace = await workspacesService.get(ctx, { workspaceId });
    } catch {
      workspace = null;
    }
    if (!workspace) {
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
    const email = String(body.email ?? "");
    const existingUser = await users.getByEmail(ctx, email);
    const user = await users.upsert(ctx, {
      id: existingUser?.id,
      email,
      displayName: requestedDisplayName || email,
      role: "user",
    });
    const existingMember = await workspacesService.getMember(ctx, {
      workspaceId,
      userId: user.id,
    });
    await assertCanUpsertMember({
      ctx,
      actorUserId: actor.user?.id,
      workspaceId,
      existingMember,
      nextRole: role,
    });
    const member = existingMember
      ? (
          await workspacesService.updateMemberRole(ctx, {
            memberId: existingMember.id,
            role,
          })
        ).data
      : await workspacesService.addMember(ctx, {
          workspaceId,
          userId: user.id,
          role,
        });
    const magic =
      body.send_magic_link === false
        ? null
        : await (async () => {
            const rawToken = crypto.randomUUID().replaceAll("-", "");
            const { sha256Hex } = await import("../../../../lib/runtime");
            const tokenHash = await sha256Hex(rawToken);
            await auth.createMagicLink(ctx, {
              email: user.email,
              tokenHash,
              redirectTo: safeLocalRedirectPath(
                body.redirect_to ? String(body.redirect_to) : null,
              ),
            });
            return { rawToken };
          })();
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

    await audit.record(ctx, {
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
      member: await serializeMember(ctx, member),
      magic_link_created: Boolean(magic),
      delivery,
      delivery_warning: deliveryWarning,
      manual_verify_url: manualVerifyUrl,
      existing_member: Boolean(existingMember),
    };
    if (magic && import.meta.env.DEV) {
      response.debug_verify_url = verifyUrl;
    }
    const treeVersion = (await buildWorkspaceNavigation(actor, workspaceId))
      .treeVersion;
    return jsonWithEnvelope(
      response,
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`members:${workspaceId}`, `member:${member.id}`],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Workspace invite failed.");
  }
};
