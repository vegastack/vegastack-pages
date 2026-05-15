import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor } from "../../../../lib/access";
import { ensureSeedData, workspaceService } from "../../../../lib/runtime";
import { canReadWorkspaceOrScopedPages } from "../../../../lib/workspace-visibility";
import {
  buildWorkspaceNavigation,
  filterWorkspaceNavigation,
} from "../../../../lib/workspace-navigation";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const requestUrl = url ?? new URL(request.url);
    const workspaceId = params.workspaceId ?? "";
    const actor = await getApiRequestActor(cookies, request);
    if (!canReadWorkspaceOrScopedPages(actor, workspaceId)) {
      throw new AppError("PERMISSION_DENIED", "Permission denied.", 403);
    }
    const nav = buildWorkspaceNavigation(actor, workspaceId);
    const requestedVersion = requestUrl.searchParams.get("version");
    if (requestedVersion && requestedVersion === nav.treeVersion) {
      return Response.json({
        tree_version: nav.treeVersion,
        page_count: nav.visiblePages.length,
        folder_count: nav.visibleFolders.length,
        unchanged: true,
      });
    }
    const depth = parsePositiveInt(requestUrl.searchParams.get("depth"));
    const folderId = requestUrl.searchParams.get("folder_id")?.trim() || null;
    const includeCounts =
      requestUrl.searchParams.get("include_counts") === "true";
    const updatedAfter = requestUrl.searchParams.get("updated_after");
    const filtered = filterWorkspaceNavigation(nav, {
      folderId,
      depth,
      updatedAfter,
    });
    if (!filtered) {
      throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
    }
    const filteredPages = filtered.pages;
    const filteredFolders = filtered.folders;
    const visiblePageIds = new Set(filteredPages.map((page) => page.id));
    const tree = workspaceService.tree({
      workspaceId,
      visiblePageIds,
      pages: filteredPages.map((page) => ({
        id: page.id,
        folderPath: page.folderPath,
        title: page.title,
        slugId: page.slugId,
      })),
    });
    return Response.json(
      {
        ...tree,
        folders: filteredFolders,
        tree_version: nav.treeVersion,
        page_count: nav.visiblePages.length,
        folder_count: nav.visibleFolders.length,
        favorite_page_ids: [...nav.favoritePageIds],
        counts: includeCounts
          ? {
              pages: nav.visiblePages.length,
              folders: nav.visibleFolders.length,
            }
          : undefined,
        partial: Boolean(folderId || depth || updatedAfter),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(error.toJSON(), { status: error.status });
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Workspace tree failed." } },
      { status: 500 },
    );
  }
};

function parsePositiveInt(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
