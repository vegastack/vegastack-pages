import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
  resolveActorPermission,
} from "../../../../lib/access";
import {
  ensureSeedData,
  favoriteService,
  pageService,
  permissionService,
} from "../../../../lib/runtime";

export const prerender = false;

async function resolveFavoriteTarget(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  url: URL,
  pageId: string,
) {
  await ensureSeedData();
  const actor = await getApiRequestActor(cookies, request);
  if (!actor.user) {
    throw new AppError("AUTH_REQUIRED", "Sign in to manage favorites.", 401);
  }

  const page = pageService
    .listPages()
    .find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
  }
  assertApiWorkspaceId({ url, workspaceId: page.workspaceId });

  const permission = resolveActorPermission({ actor, page });
  permissionService.assert({ actual: permission, required: "read" });
  return { user: actor.user, page };
}

export const PUT: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { user, page } = await resolveFavoriteTarget(
      cookies,
      request,
      url,
      params.pageId ?? "",
    );
    const favorite = favoriteService.add(user.id, page);
    return Response.json({
      favorite: {
        page_id: favorite.pageId,
        workspace_id: favorite.workspaceId,
        created_at: favorite.createdAt,
      },
    });
  } catch (error) {
    return jsonAppError(error, "Favorite update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { user, page } = await resolveFavoriteTarget(
      cookies,
      request,
      url,
      params.pageId ?? "",
    );
    favoriteService.remove(user.id, page.id);
    return Response.json({ favorite: null });
  } catch (error) {
    return jsonAppError(error, "Favorite update failed.");
  }
};
