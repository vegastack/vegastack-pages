import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { workspaces as workspacesService } from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { canReadWorkspaceOrScopedPages } from "../../../../lib/workspace-visibility";
import {
  buildWorkspaceNavigation,
  filterWorkspaceNavigation,
} from "../../../../lib/workspace-navigation";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const requestUrl = url ?? new URL(request.url);
    const workspaceId = params.workspaceId ?? "";
    const actor = await getApiRequestActor(cookies, request);
    if (!(await canReadWorkspaceOrScopedPages(actor, workspaceId))) {
      throw new AppError("PERMISSION_DENIED", "Permission denied.", 403);
    }
    const nav = await buildWorkspaceNavigation(actor, workspaceId);
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
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const workspace = await workspacesService.get(ctx, { workspaceId });
    const treePages = filteredPages
      .map((page) => ({
        id: page.id,
        folderPath: page.folderPath,
        title: page.title,
        slugId: page.slugId,
      }))
      .sort(
        (left, right) =>
          left.folderPath.localeCompare(right.folderPath) ||
          left.title.localeCompare(right.title),
      );
    return Response.json(
      {
        workspace,
        folders: filteredFolders,
        pages: treePages,
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
    return serviceErrorToResponse(error, "Workspace tree failed.");
  }
};

function parsePositiveInt(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
