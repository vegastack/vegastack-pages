import { AppError } from "@vegastack/pages-core";
import { audit, auth, users, workspaces } from "@vegastack/pages-services";
import { magicLinkHandoffUrl } from "../../magic-link";
import { sendMagicLinkEmail } from "../../email";
import { sha256Hex } from "../../runtime";
import { validateEditableSource } from "../../source-validation";
import { asString, requiredWorkspaceId } from "../util";
import { assertWorkspacePermission, getExistingPage } from "../permissions";
import type { McpToolContext } from "../types";

export async function inviteWorkspaceMember(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "admin");
  const role =
    args.role === "admin" ||
    args.role === "editor" ||
    args.role === "commenter" ||
    args.role === "reader"
      ? args.role
      : "reader";
  const user = await users.upsert(ctx, {
    email: asString(args.email),
    displayName: args.display_name
      ? String(args.display_name)
      : asString(args.email),
  });
  const existingMember = await workspaces.getMember(ctx, {
    workspaceId,
    userId: user.id,
  });
  const member = await workspaces.addMember(ctx, {
    workspaceId,
    userId: user.id,
    role,
  });
  const rawToken = crypto.randomUUID().replaceAll("-", "");
  const tokenHash = await sha256Hex(rawToken);
  await auth.createMagicLink(ctx, {
    email: user.email,
    tokenHash,
    redirectTo: "/app",
  });
  const requestOrigin = new URL(context.requestUrl).origin;
  const verifyUrl = magicLinkHandoffUrl(requestOrigin, rawToken);
  const workspace = await workspaces.get(ctx, { workspaceId });
  let delivery: Record<string, unknown> | null = null;
  let deliveryWarning: string | null = null;
  try {
    delivery = await sendMagicLinkEmail({
      to: user.email,
      verifyUrl,
      workspaceName: workspace?.name ?? null,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "EMAIL_NOT_CONFIGURED") {
      delivery = { provider: "manual", sent: false };
      deliveryWarning =
        "Email is not configured. No sign-in link was returned to the MCP client.";
    } else {
      throw error;
    }
  }
  const devVerifyUrl =
    import.meta.env.DEV &&
    process.env.VPG_RETURN_VERIFY_URL_IN_INVITE === "true"
      ? verifyUrl
      : null;
  await audit.record(ctx, {
    workspaceId,
    actorUserId: context.actor.user?.id ?? null,
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
      returned_verify_url: Boolean(devVerifyUrl),
      source: "mcp",
    },
  });
  return {
    user,
    member,
    magic_link_created: true,
    delivery,
    delivery_warning: deliveryWarning,
    dev_verify_url: devVerifyUrl,
  };
}

export async function validatePageSource(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const pageId = args.page_id ? String(args.page_id) : null;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  const page = pageId
    ? await getExistingPage(context, pageId, "read", workspaceId)
    : null;
  if (!page) await assertWorkspacePermission(context, workspaceId, "read");
  const source =
    args.source === undefined ? (page?.source ?? "") : String(args.source);
  const sourceType =
    args.source_type === "mdx" || args.source_type === "html"
      ? args.source_type
      : (page?.page.sourceType ?? "markdown");
  return validateEditableSource({ source, sourceType });
}
