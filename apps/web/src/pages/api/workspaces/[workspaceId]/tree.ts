import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor } from "../../../../lib/access";
import { ensureSeedData, workspaceService } from "../../../../lib/runtime";
import {
  canReadWorkspaceOrScopedPages,
  listVisibleFoldersForActor,
  listVisiblePagesForActor,
} from "../../../../lib/workspace-visibility";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await getApiRequestActor(cookies, request);
    if (!canReadWorkspaceOrScopedPages(actor, workspaceId)) {
      throw new AppError("PERMISSION_DENIED", "Permission denied.", 403);
    }
    const pages = listVisiblePagesForActor(actor, workspaceId);
    const visiblePageIds = new Set(pages.map((page) => page.id));
    const tree = workspaceService.tree({
      workspaceId,
      visiblePageIds,
      pages: pages.map((page) => ({
        id: page.id,
        folderPath: page.folderPath,
        title: page.title,
        slugId: page.slugId,
      })),
    });
    return Response.json({
      ...tree,
      folders: listVisibleFoldersForActor(actor, workspaceId),
    });
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(error.toJSON(), { status: error.status });
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Workspace tree failed." } },
      { status: 500 },
    );
  }
};
