import { folders, pages, search } from "@vegastack/pages-services";
import { asString, clampNumber, requiredWorkspaceId } from "../util";
import {
  assertWorkspacePermission,
  canReadPage,
  canUseFolder,
} from "../permissions";
import type { McpToolContext } from "../types";

type SearchResultLike = {
  resourceType?: string;
  folderId?: string | null;
  pageId?: string | null;
};

async function canReadSearchResult(
  context: McpToolContext,
  workspaceId: string,
  result: SearchResultLike,
) {
  const ctx = context.ctx;
  if (result.resourceType === "folder") {
    const folder = result.folderId
      ? await folders.get(ctx, result.folderId)
      : null;
    return folder ? canUseFolder(context, folder, "read") : false;
  }
  const pageId = result.pageId;
  if (!pageId) return false;
  const page = await pages.get(ctx, pageId);
  if (!page || page.page.workspaceId !== workspaceId) return false;
  return canReadPage(context, page.page);
}

export async function searchWorkspace(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "read");
  const searchResults = await search.query(ctx, {
    workspaceId,
    query: asString(args.query),
    limit: clampNumber(args.limit, 10, 1, 50),
  });
  const visible = await Promise.all(
    searchResults.map(async (result) => ({
      result,
      ok: await canReadSearchResult(context, workspaceId, result),
    })),
  );
  return {
    results: visible.filter((entry) => entry.ok).map((entry) => entry.result),
  };
}
