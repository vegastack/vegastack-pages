import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  comments as commentsService,
  isServiceError,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { coerceCommentAnchor } from "../../../../lib/comment-anchor-api";
import { numericEnv, readJsonBody } from "../../../../lib/request-body";
import {
  commentService,
  ensureSeedData,
  scheduleIndexCommentThread,
  pageService,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;
const defaultMaxAnchorUpdateBytes = 32 * 1024;

function maxAnchorUpdateBytes() {
  return numericEnv(
    "VPG_MAX_COMMENT_ANCHOR_UPDATE_BYTES",
    defaultMaxAnchorUpdateBytes,
  );
}

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: maxAnchorUpdateBytes(),
      label: "Anchor update",
    });
    const thread = commentService.getThread(params.threadId ?? "");
    if (!thread) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    const page = await pageService.getPage(thread.thread.pageId);
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "comment",
    });
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const result = await commentsService.updateAnchor(ctx, {
      threadId: thread.thread.id,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
      anchor: coerceCommentAnchor(body.anchor, {
        contentHash: page.page.contentHash,
        selectedText: thread.anchor.selectedText,
        kind: thread.anchor.kind,
        surface: thread.anchor.surface,
        confidence: "fuzzy",
      }),
    });
    scheduleIndexCommentThread(thread.thread.id);
    return Response.json({ anchor: result.data, envelope: result.envelope });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Anchor update failed.");
  }
};
