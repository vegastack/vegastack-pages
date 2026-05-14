import { AppError, hasPermission } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  getApiRequestActor,
  jsonAppError,
  resolveActorPermission,
} from "../../../../lib/access";
import {
  ensureSeedData,
  favoriteService,
  pageService,
} from "../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    if (!workspaceId) {
      throw new AppError("VALIDATION_ERROR", "workspaceId is required.", 400);
    }

    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Sign in to manage favorites.", 401);
    }

    const pageById = new Map(
      pageService.listPages(workspaceId).map((page) => [page.id, page]),
    );
    const favorites = favoriteService
      .listForWorkspace(actor.user.id, workspaceId)
      .map((favorite) => {
        const page = pageById.get(favorite.pageId);
        if (!page) return null;
        const permission = resolveActorPermission({ actor, page });
        if (!hasPermission(permission, "read")) return null;
        return {
          page_id: page.id,
          workspace_id: page.workspaceId,
          title: page.title,
          slug_id: page.slugId,
          url: `/p/${page.slugId}`,
          created_at: favorite.createdAt,
        };
      })
      .filter((favorite): favorite is NonNullable<typeof favorite> =>
        Boolean(favorite),
      );

    return Response.json({ favorites });
  } catch (error) {
    return jsonAppError(error, "Favorites lookup failed.");
  }
};
