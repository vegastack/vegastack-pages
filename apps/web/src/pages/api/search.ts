import type { APIRoute } from "astro";
import {
  AppError,
  hasPermission,
  type SearchResourceType,
} from "@vegastack/pages-core";
import {
  getApiRequestActor,
  jsonAppError,
  resolveActorPermission,
} from "../../lib/access";
import {
  ensureSeedData,
  favoriteService,
  listRecentSearchResources,
  pageService,
  recordSearchResourceOpen,
  searchIndexedResources,
} from "../../lib/runtime";
import {
  canReadFolderOrVisibleDescendants,
  canReadWorkspaceOrScopedPages,
} from "../../lib/workspace-visibility";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    await ensureSeedData();
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
    const actor = await getApiRequestActor(cookies, request);
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
    if (actor.user && !canReadWorkspaceOrScopedPages(actor, workspaceId)) {
      return Response.json({ results: [] });
    }
    if (!query.trim()) {
      const recent = await listRecentSearchResources({
        userId: actor.user?.id ?? null,
        workspaceId,
        limit,
      });
      return Response.json({
        results: filterSearchResultsByPermission(recent, actor, workspaceId),
      });
    }
    const favoritePageIds = actor.user
      ? new Set(
          favoriteService
            .listForWorkspace(actor.user.id, workspaceId)
            .map((favorite) => favorite.pageId),
        )
      : undefined;
    const results = (
      await searchIndexedResources(workspaceId, query, {
        limit: Number.isFinite(limit) ? limit : 10,
        type: requestedType,
        favoritePageIds,
      })
    ).filter((result) => canReadSearchResult({ result, actor, workspaceId }));

    return Response.json({ results });
  } catch (error) {
    return jsonAppError(error, "Search failed.");
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
  actor: Awaited<ReturnType<typeof getApiRequestActor>>,
  workspaceId: string,
) {
  return results.filter((result) =>
    canReadSearchResult({ result, actor, workspaceId }),
  );
}

function canReadSearchResult(input: {
  result: Awaited<ReturnType<typeof searchIndexedResources>>[number];
  actor: Awaited<ReturnType<typeof getApiRequestActor>>;
  workspaceId: string;
}) {
  if (input.result.type === "folder") {
    return (
      input.result.folderId &&
      canReadFolderOrVisibleDescendants(input.actor, input.result.folderId)
    );
  }
  const pageId = input.result.pageId;
  if (!pageId) return false;
  const page = pageService
    .listPages(input.workspaceId)
    .find((candidate) => candidate.id === pageId);
  if (!page) return false;
  const permission = resolveActorPermission({ actor: input.actor, page });
  return hasPermission(permission, "read");
}
