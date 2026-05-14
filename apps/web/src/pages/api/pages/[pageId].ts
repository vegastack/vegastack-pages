import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../lib/access";
import {
  commentService,
  ensureSeedData,
  pageService,
} from "../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.pageId
      ? await pageService.getPage(params.pageId)
      : null;
    if (!page) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    return Response.json({
      page_id: page.page.id,
      workspace_id: page.page.workspaceId,
      title: page.page.title,
      slug_id: page.page.slugId,
      url: `/p/${page.page.slugId}`,
      folder_path: page.page.folderPath,
      source_type: page.page.sourceType,
      version_id: page.page.versionId,
      content_hash: page.page.contentHash,
      updated_at: page.page.updatedAt,
      permission: access.permission,
      open_comment_count: commentService.listForPage(page.page.id).length,
    });
  } catch (error) {
    return jsonAppError(error, "Page metadata failed.");
  }
};
