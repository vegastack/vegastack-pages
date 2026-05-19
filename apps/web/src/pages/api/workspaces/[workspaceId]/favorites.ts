import { AppError, hasPermission } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  favorites as favoritesService,
  pages as pagesService,
} from "@vegastack/pages-services";
import {
  getApiRequestActor,
  jsonAppError,
  resolveActorPermission,
} from "../../../../lib/access";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    if (!workspaceId) {
      throw new AppError("VALIDATION_ERROR", "workspaceId is required.", 400);
    }

    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Sign in to manage favorites.", 401);
    }
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });

    const pageById = new Map(
      (await pagesService.list(ctx, workspaceId)).map((page) => [
        page.id,
        page,
      ]),
    );
    const favoriteRows = await favoritesService.listForWorkspace(ctx, {
      workspaceId,
    });
    // Resolve per-page permissions in parallel — async permission checks
    // can't sit inside a sync `.map` callback. After resolution we drop
    // the nulls (page missing OR no read access) in one pass.
    const favoritesWithMaybe = await Promise.all(
      favoriteRows.map(async (favorite) => {
        const page = pageById.get(favorite.pageId);
        if (!page) return null;
        const permission = await resolveActorPermission({ actor, page });
        if (!hasPermission(permission, "read")) return null;
        return {
          page_id: page.id,
          workspace_id: page.workspaceId,
          title: page.title,
          slug_id: page.slugId,
          url: `/p/${page.slugId}`,
          created_at: favorite.createdAt,
        };
      }),
    );
    const favorites = favoritesWithMaybe.filter(
      (favorite): favorite is NonNullable<typeof favorite> => Boolean(favorite),
    );

    return Response.json({ favorites });
  } catch (error) {
    return jsonAppError(error, "Favorites lookup failed.");
  }
};
