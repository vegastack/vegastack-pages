import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  comments as commentsService,
  pages as pagesService,
  isServiceError,
  requireDb,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { coerceCommentAnchor } from "../../../../lib/comment-anchor-api";
import { numericEnv, readJsonBody } from "../../../../lib/request-body";
import { scheduleIndexCommentThread } from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;
const defaultMaxAnchorUpdateBytes = 32 * 1024;

function maxAnchorUpdateBytes() {
  return numericEnv(
    "VPG_MAX_COMMENT_ANCHOR_UPDATE_BYTES",
    defaultMaxAnchorUpdateBytes,
  );
}

type ThreadLookupRow = {
  page_id: string;
  selected_text: string | null;
  anchor_kind: string | null;
  surface: string | null;
};

async function loadThreadLookup(
  ctx: Awaited<ReturnType<typeof buildServiceContext>>["ctx"],
  threadId: string,
): Promise<ThreadLookupRow | null> {
  const db = requireDb(ctx);
  return db
    .prepare(
      `SELECT t.page_id AS page_id,
              a.selected_text AS selected_text,
              a.anchor_kind   AS anchor_kind,
              a.surface       AS surface
         FROM comment_threads t
         LEFT JOIN comment_anchors a ON a.thread_id = t.id
        WHERE t.id = ?1`,
    )
    .bind(threadId)
    .first<ThreadLookupRow>();
}

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: maxAnchorUpdateBytes(),
      label: "Anchor update",
    });
    const threadId = params.threadId ?? "";
    // First pass: build a ctx without workspaceId so we can query the
    // thread row to learn its pageId/workspaceId, then rebuild with the
    // correct workspaceId for the mutation.
    const bootstrap = await buildServiceContext({ cookies, request });
    const lookup = await loadThreadLookup(bootstrap.ctx, threadId);
    if (!lookup) {
      throw new AppError(
        "THREAD_NOT_FOUND",
        "Comment thread was not found.",
        404,
      );
    }
    const page = await pagesService.get(bootstrap.ctx, lookup.page_id);
    if (!page) {
      throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    }
    // Authorization side-effect: throws on insufficient access.
    await resolvePageAccess({
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
      threadId,
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
      anchor: coerceCommentAnchor(body.anchor, {
        contentHash: page.page.contentHash,
        selectedText: lookup.selected_text ?? "",
        kind: lookup.anchor_kind === "point" ? "point" : "text",
        surface: lookup.surface === "html" ? "html" : "prose",
        confidence: "fuzzy",
      }),
    });
    scheduleIndexCommentThread(threadId);
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
