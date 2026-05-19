import type { APIRoute } from "astro";
import { AppError, type SearchResourceType } from "@vegastack/pages-core";
import { favorites } from "@vegastack/pages-services";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../lib/service-context";
import {
  listRecentSearchResources,
  recordSearchResourceOpen,
  searchIndexedResources,
} from "../../lib/runtime";
import { canReadWorkspaceOrScopedPages } from "../../lib/workspace-visibility";
import {
  buildWorkspaceNavigation,
  canReadFolderFromNavigation,
  type WorkspaceNavigationModel,
} from "../../lib/workspace-navigation";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    const workspaceId = url.searchParams.get("workspace_id")?.trim();
    if (!workspaceId) {
      throw new AppError(
        "WORKSPACE_REQUIRED",
        "workspace_id is required for this API request.",
        400,
        {
          parameter: "workspace_id",
          location: "query",
          hint: "Pass workspace_id when searching pages.",
        },
      );
    }
    const query = url.searchParams.get("q") ?? "";
    const requestedType = normalizeSearchType(url.searchParams.get("type"));
    const limit = Math.min(
      25,
      Math.max(1, Number(url.searchParams.get("limit") ?? "10")),
    );
    const { ctx, actor } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    if (request?.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const type = normalizeSearchType(String(body.type ?? ""));
      const id = String(body.id ?? "").trim();
      if (type !== "all" && id) {
        await recordSearchResourceOpen({
          userId: actor.user?.id ?? null,
          workspaceId,
          type,
          id,
        });
      }
      return Response.json({ ok: true });
    }
    if (
      actor.user &&
      !(await canReadWorkspaceOrScopedPages(actor, workspaceId))
    ) {
      return Response.json({ results: [] });
    }
    const nav = await buildWorkspaceNavigation(actor, workspaceId);
    if (!query.trim()) {
      const recent = await listRecentSearchResources({
        userId: actor.user?.id ?? null,
        workspaceId,
        limit,
      });
      const include = new Set(
        (url.searchParams.get("include") ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      const favoriteRecords =
        actor.user && include.has("favorites")
          ? await favorites.listForWorkspace(ctx, { workspaceId })
          : [];
      const favoritesResult = favoriteRecords
        .map((favorite) => {
          const page = nav.visiblePageById.get(favorite.pageId);
          if (!page) return null;
          return {
            type: "page" as const,
            id: page.id,
            pageId: page.id,
            folderId: null,
            title: page.title,
            url: `/p/${page.slugId}`,
            path: page.folderPath
              ? `${page.folderPath}/${page.title}`
              : page.title,
            subtitle: "Favorite",
            snippet: "",
            updatedAt: favorite.createdAt,
            icon: "file-text" as const,
            matchedField: "title" as const,
          };
        })
        .filter((favorite): favorite is NonNullable<typeof favorite> =>
          Boolean(favorite),
        )
        .slice(0, Math.min(limit, 10));
      return Response.json({
        results: filterSearchResultsByPermission(recent, nav),
        favorites: favoritesResult,
      });
    }
    const favoritePageIds = actor.user
      ? new Set(
          (await favorites.listForWorkspace(ctx, { workspaceId })).map(
            (favorite) => favorite.pageId,
          ),
        )
      : undefined;
    const results = (
      await searchIndexedResources(workspaceId, query, {
        limit: Number.isFinite(limit) ? limit : 10,
        type: requestedType,
        favoritePageIds,
      })
    ).filter((result) => canReadSearchResult({ result, nav }));

    return Response.json({ results });
  } catch (error) {
    return serviceErrorToResponse(error, "Search failed.");
  }
};

export const POST = GET;

function normalizeSearchType(value: string | null): SearchResourceType | "all" {
  return value === "page" || value === "folder" || value === "comment_thread"
    ? value
    : value === "comment"
      ? "comment_thread"
      : "all";
}

function filterSearchResultsByPermission(
  results: Awaited<ReturnType<typeof searchIndexedResources>>,
  nav: WorkspaceNavigationModel,
) {
  return results.filter((result) => canReadSearchResult({ result, nav }));
}

function canReadSearchResult(input: {
  result: Awaited<ReturnType<typeof searchIndexedResources>>[number];
  nav: WorkspaceNavigationModel;
}) {
  if (input.result.type === "folder") {
    return (
      input.result.folderId &&
      canReadFolderFromNavigation(input.nav, input.result.folderId)
    );
  }
  const pageId = input.result.pageId;
  if (!pageId) return false;
  return input.nav.visiblePageById.has(pageId);
}
