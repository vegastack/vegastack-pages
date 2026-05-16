import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  comments as commentsService,
  isServiceError,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { clientRateLimitKey } from "../../../../lib/client-address";
import { coerceCommentAnchor } from "../../../../lib/comment-anchor-api";
import { enrichThread, enrichThreads } from "../../../../lib/comments-enrich";
import { guestSessionForPublication } from "../../../../lib/guest-session";
import {
  assertUtf8ByteLimit,
  numericEnv,
  readJsonBody,
} from "../../../../lib/request-body";
import {
  checkRateLimit,
  commentService,
  ensureSeedData,
  scheduleIndexCommentThread,
  pageService,
  publicationService,
  reviewEventService,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;
const defaultMaxPublicCommentBodyBytes = 10_000;
const jsonOverheadBytes = 64 * 1024;

function maxPublicCommentBodyBytes() {
  return numericEnv(
    "VPG_MAX_PUBLIC_COMMENT_BODY_BYTES",
    defaultMaxPublicCommentBodyBytes,
  );
}

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
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const status = url.searchParams.get("status");
    return Response.json({
      threads: enrichThreads(
        commentService.listForPage(
          page.page.id,
          status === "resolved" || status === "all" ? status : "open",
        ),
      ),
    });
  } catch (error) {
    return jsonAppError(error, "Comment listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
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
    const maxCommentBytes = maxPublicCommentBodyBytes();
    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: maxCommentBytes + jsonOverheadBytes,
      label: "Comment creation",
    });
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "comment",
      guestName: body.guest_name ? String(body.guest_name) : null,
    });
    let guestSession = null;
    if (!access.actor.user) {
      const publication = access.publicationId
        ? publicationService.get(access.publicationId)
        : null;
      if (!publication) {
        throw new AppError(
          "AUTH_REQUIRED",
          "A public publication is required for guest comments.",
          401,
        );
      }
      guestSession = await guestSessionForPublication({
        cookies,
        url,
        publication,
        requestedName: body.guest_name ? String(body.guest_name) : null,
      });
      await checkRateLimit({
        key: `guest-comment:${access.publicationId}:${guestSession.id ?? clientRateLimitKey(request, "guest-comment")}`,
        limit: 20,
        windowMs: 60 * 60_000,
      });
    }
    const commentBody = String(body.body ?? "");
    assertUtf8ByteLimit({
      value: commentBody,
      maxBytes: maxCommentBytes,
      label: "Comment body",
      detailKey: "max_public_comment_body_bytes",
    });
    const anchor = coerceCommentAnchor(body.anchor, {
      contentHash: page.page.contentHash,
    });
    if (anchor.sourceStart === null && anchor.selectedText.trim()) {
      const sourceStart = findAnchoredIndex(
        page.source,
        anchor.selectedText,
        anchor.prefixText,
        anchor.suffixText,
      );
      if (sourceStart >= 0) {
        anchor.sourceStart = sourceStart;
        anchor.sourceEnd = sourceStart + anchor.selectedText.length;
        anchor.selector = {
          ...(anchor.selector ?? {}),
          position: {
            ...(anchor.selector?.position ?? {}),
            sourceStart: anchor.sourceStart,
            sourceEnd: anchor.sourceEnd,
          },
        };
      }
    }
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: page.page.workspaceId,
    });
    const result = await commentsService.createThread(ctx, {
      pageId: page.page.id,
      workspaceId: page.page.workspaceId,
      body: commentBody,
      authorUserId: access.actor.user?.id ?? null,
      guestName: guestSession?.guestName ?? null,
      guestSessionId: guestSession?.id ?? null,
      publicationId: guestSession?.publicationId ?? null,
      anchor,
    });
    const created = result.data;
    reviewEventService.emit({
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "comment.created",
      actorUserId: access.actor.user?.id ?? null,
      payload: { thread_id: created.thread.id },
    });
    scheduleIndexCommentThread(created.thread.id);
    return Response.json({
      ...enrichThread(created),
      envelope: result.envelope,
    });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Comment creation failed.");
  }
};

function findAnchoredIndex(
  text: string,
  selectedText: string,
  prefixText: string,
  suffixText: string,
) {
  if (!text || !selectedText) return -1;
  let bestIndex = text.indexOf(selectedText);
  let bestScore = bestIndex >= 0 ? 0 : -1;
  let index = bestIndex;
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - prefixText.length), index);
    const suffix = text.slice(
      index + selectedText.length,
      index + selectedText.length + suffixText.length,
    );
    const score =
      commonSuffixLength(prefix, prefixText) +
      commonPrefixLength(suffix, suffixText);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
    index = text.indexOf(selectedText, index + selectedText.length);
  }
  return bestIndex;
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

function commonSuffixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (
    count < limit &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}
