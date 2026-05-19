import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  users,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import {
  assertWorkspaceActorPermission,
  getApiRequestActor,
} from "../../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

// GET /api/workspaces/[workspaceId]/members
//
// Lists every workspace member with their joined user record (email +
// display name + role). The MCP `fetch` tool with `include: ["members"]`
// returns the same shape via JSON-RPC; this REST endpoint exists so the
// CLI (and any plain HTTP client) can read it without going through MCP.
//
// SECURITY: Requires workspace `read` permission. Member listings expose
// every member's email address — leaking those to non-members would let
// anyone enumerate a workspace's team. The audit cycle 4 review caught
// the original version of this route shipping with no auth check.
export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    if (!workspaceId) {
      throw new AppError(
        "WORKSPACE_REQUIRED",
        "workspace_id is required.",
        400,
      );
    }
    const actor = await getApiRequestActor(cookies, request);
    await assertWorkspaceActorPermission({
      actor,
      workspaceId,
      required: "read",
    });
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const memberRows = await workspacesService.listMembers(ctx, {
      workspaceId,
    });
    const members = await Promise.all(
      memberRows.map(async (member) => {
        const user = await users.getById(ctx, member.userId).catch(() => null);
        return {
          id: member.id,
          user_id: member.userId,
          email: user?.email ?? null,
          display_name: user?.displayName ?? null,
          role: member.role,
          created_at: member.createdAt,
          updated_at: member.updatedAt,
        };
      }),
    );
    return Response.json({ workspace_id: workspaceId, members });
  } catch (error) {
    return serviceErrorToResponse(error, "Could not list workspace members.");
  }
};
