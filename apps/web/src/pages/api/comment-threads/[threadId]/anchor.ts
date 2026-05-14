import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { coerceCommentAnchor } from "../../../../lib/comment-anchor-api";
import { numericEnv, readJsonBody } from "../../../../lib/request-body";
import {
  commentService,
  ensureSeedData,
  indexCommentThread,
  pageService,
} from "../../../../lib/runtime";

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
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "comment",
    });
    const updated = commentService.updateAnchor({
      threadId: thread.thread.id,
      anchor: coerceCommentAnchor(body.anchor, {
        contentHash: page.page.contentHash,
        selectedText: thread.anchor.selectedText,
        kind: thread.anchor.kind,
        surface: thread.anchor.surface,
        confidence: "fuzzy",
      }),
    });
    await indexCommentThread(thread.thread.id);
    return Response.json({ anchor: updated });
  } catch (error) {
    return jsonAppError(error, "Anchor update failed.");
  }
};
