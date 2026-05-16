// Favorite toggle route — routed through @vegastack/pages-services.

import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { favorites as favoritesService } from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  resolveActorPermission,
} from "../../../../lib/access";
import {
  ensureSeedData,
  pageService,
  permissionService,
} from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

async function resolveFavoriteContext(
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
  const page = pageService.listPages().find((entry) => entry.id === pageId);
  if (!page) {
    throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
  }
  assertApiWorkspaceId({ url, workspaceId: page.workspaceId });
  const permission = resolveActorPermission({ actor, page });
  permissionService.assert({ actual: permission, required: "read" });

  const { ctx } = await buildServiceContext({
    cookies,
    request,
    workspaceId: page.workspaceId,
  });
  return { ctx, page };
}

export const PUT: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx, page } = await resolveFavoriteContext(
      cookies,
      request,
      url,
      params.pageId ?? "",
    );
    const result = await favoritesService.add(ctx, { pageId: page.id });
    return Response.json({
      favorite: {
        page_id: result.favorite!.pageId,
        workspace_id: result.favorite!.workspaceId,
        created_at: result.favorite!.createdAt,
      },
      envelope: result.envelope,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Favorite update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx, page } = await resolveFavoriteContext(
      cookies,
      request,
      url,
      params.pageId ?? "",
    );
    const result = await favoritesService.remove(ctx, { pageId: page.id });
    return Response.json({
      favorite: null,
      envelope: result.envelope,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Favorite update failed.");
  }
};
