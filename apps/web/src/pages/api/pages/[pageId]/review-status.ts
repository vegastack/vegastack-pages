import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { enrichThreads } from "../../../../lib/comments-enrich";
import {
  commentService,
  ensureSeedData,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.pageId ? await getPageByRef(params.pageId) : null;
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const afterId = url.searchParams.get("after_id");
    const limit = clamp(Number(url.searchParams.get("limit") ?? "50"), 1, 100);
    const until = url.searchParams.get("until") ?? "first_response";
    const includeThreads = url.searchParams.get("include_threads") ?? "matches";
    const events = reviewEventService.list({
      pageId: page.page.id,
      afterId,
      limit,
    });
    const threadRecords = commentService.listForPage(page.page.id, "all");
    const openThreadRecords = threadRecords.filter(
      (thread) => thread.thread.status === "open",
    );
    const commentEvents = events.filter((event) =>
      event.type.startsWith("comment."),
    );
    const matched =
      until === "all_threads_resolved"
        ? threadRecords.length > 0 && openThreadRecords.length === 0
        : until === "timeout"
          ? false
          : threadRecords.length > 0 || commentEvents.length > 0;
    const eventThreadIds = new Set(
      commentEvents
        .map((event) => event.payload?.thread_id)
        .filter((value): value is string => typeof value === "string"),
    );
    const selectedThreads =
      includeThreads === "all"
        ? threadRecords
        : includeThreads === "none"
          ? []
          : until === "all_threads_resolved"
            ? matched
              ? threadRecords
              : openThreadRecords
            : threadRecords.filter(
                (thread) =>
                  thread.thread.status === "open" ||
                  eventThreadIds.has(thread.thread.id),
              );
    const threads = enrichThreads(selectedThreads.slice(0, limit));
    return Response.json(
      {
        page_id: page.page.id,
        status: matched ? "matched" : "pending",
        condition: until,
        open_thread_count: openThreadRecords.length,
        unresolved_thread_count: openThreadRecords.length,
        thread_count: threadRecords.length,
        threads,
        events,
        next_cursor: events.at(-1)?.id ?? afterId ?? null,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return jsonAppError(error, "Review status failed.");
  }
};

async function getPageByRef(ref: string) {
  if (ref.startsWith("pg_")) return pageService.getPage(ref);
  return pageService.getPageBySlugId(ref);
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
