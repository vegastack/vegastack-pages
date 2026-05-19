import { AppError } from "@vegastack/pages-core";
import { workspaces } from "@vegastack/pages-services";
import type { McpToolContext } from "../types";

export async function whoami(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const user = context.actor.user;
  // Only enumerate workspaces when the caller explicitly opts in via
  // include=['workspaces']. Previously whoami always called
  // `workspaces.listForUser`, which scales linearly with the user's
  // workspace count and is wasted work when the caller just wants
  // identity. (Audit cycle 5 finding.)
  const includes = Array.isArray(args.include)
    ? new Set(args.include.map((value) => String(value)))
    : new Set<string>();
  const wantsWorkspaces = includes.has("workspaces");
  if (!user) {
    return {
      user: null,
      auth_mode: context.actor.authMode,
      workspaces: wantsWorkspaces ? [] : undefined,
      workspace_id: context.actor.workspaceId,
    };
  }
  const body: Record<string, unknown> = {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.displayName ?? null,
      role: user.role,
    },
    auth_mode: context.actor.authMode,
    workspace_id: context.actor.workspaceId,
  };
  if (wantsWorkspaces) {
    const workspaceList = await workspaces.listForUser(ctx, {
      userId: user.id,
    });
    body.workspaces = workspaceList.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    }));
  }
  return body;
}

export async function listWorkspacesForUser(context: McpToolContext) {
  const ctx = context.ctx;
  const user = context.actor.user;
  if (!user) {
    throw new AppError("AUTH_REQUIRED", "Authentication is required.", 401);
  }
  const workspaceList = await workspaces.listForUser(ctx, {
    userId: user.id,
  });
  return Promise.all(
    workspaceList.map(async (workspace) => {
      const member = await workspaces.getMember(ctx, {
        workspaceId: workspace.id,
        userId: user.id,
      });
      return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role: member?.role ?? null,
      };
    }),
  );
}
