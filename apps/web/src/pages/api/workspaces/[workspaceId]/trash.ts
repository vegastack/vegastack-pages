// GET /api/workspaces/:id/trash?scope=mine|workspace
//
// scope=mine     → soft-deleted pages the current user trashed (the
//                  sidebar "Trash" surface). Requires read on the
//                  workspace.
// scope=workspace → every soft-deleted page in the workspace, with
//                  who-deleted metadata (the Workspace Settings →
//                  Recovery surface). Requires editor+ on the
//                  workspace; admins additionally get the Delete-
//                  forever path on each row from the UI.

import type { APIRoute } from "astro";
import {
  pages as pagesService,
  permissions as permissionsService,
  users as usersService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const workspaceId = params.workspaceId;
    if (!workspaceId) {
      return Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "workspace_id is required.",
          },
        },
        { status: 400 },
      );
    }
    const { ctx, actor } = await buildServiceContext({ cookies, request });
    if (!actor.user) {
      return Response.json(
        {
          error: {
            code: "AUTH_REQUIRED",
            message: "Sign in to view the trash.",
          },
        },
        { status: 401 },
      );
    }
    const rawScope = url.searchParams.get("scope") ?? "mine";
    const scope: "mine" | "workspace" =
      rawScope === "workspace" ? "workspace" : "mine";
    const member = await workspacesService.getMember(ctx, {
      workspaceId,
      userId: actor.user.id,
    });
    const required = scope === "workspace" ? "write" : "read";
    const workspacePermission = await permissionsService.resolve(ctx, {
      workspaceId,
      userId: actor.user.id,
      scope: "workspace",
      targetId: workspaceId,
      memberRole: member?.role ?? null,
      instanceRole: actor.user.role,
    });
    permissionsService.assertLevel({
      actual: workspacePermission,
      required,
    });

    const items = await pagesService.listTrashed(ctx, {
      workspaceId,
      scope,
      userId: actor.user.id,
    });
    // Hydrate deleted-by display names for the Recovery view. Skip when
    // scope === "mine" (it's always the current user).
    const userIds =
      scope === "workspace"
        ? Array.from(
            new Set(
              items
                .map((entry) => entry.deletedByUserId)
                .filter((id): id is string => Boolean(id)),
            ),
          )
        : [];
    const userMap = new Map<
      string,
      { id: string; displayName: string | null; email: string }
    >();
    for (const id of userIds) {
      const user = await usersService.getById(ctx, id);
      if (user) {
        userMap.set(user.id, {
          id: user.id,
          displayName: user.displayName ?? null,
          email: user.email,
        });
      }
    }
    return Response.json({
      scope,
      items: items.map((entry) => ({
        page_id: entry.pageId,
        workspace_id: entry.workspaceId,
        title: entry.title,
        folder_path: entry.folderPath,
        slug: entry.slug,
        slug_id: entry.slugId,
        source_type: entry.sourceType,
        deleted_at: entry.deletedAt,
        deleted_by:
          entry.deletedByUserId && userMap.has(entry.deletedByUserId)
            ? userMap.get(entry.deletedByUserId)
            : entry.deletedByUserId
              ? { id: entry.deletedByUserId, displayName: null, email: "" }
              : null,
      })),
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Trash listing failed.");
  }
};
