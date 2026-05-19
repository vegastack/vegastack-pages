import { AppError } from "@vegastack/pages-core";
import { comments, reviewEvents } from "@vegastack/pages-services";
import { asString, clampNumber, delay } from "../util";
import { getExistingPage } from "../permissions";
import type { McpToolContext } from "../types";

export const activeWaitForReviewCalls = new Set<string>();

export async function waitForReview(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const page = await getExistingPage(
    context,
    asString(args.page_id),
    "read",
    args.workspace_id,
  );
  const waitKey = waitForReviewKey(context, page.page.id);
  if (activeWaitForReviewCalls.has(waitKey)) {
    throw new AppError(
      "RATE_LIMITED",
      "Only one wait_for_review call may be active per actor and page.",
      429,
    );
  }
  activeWaitForReviewCalls.add(waitKey);
  try {
    return await waitForReviewLoop(context, args, page.page);
  } finally {
    activeWaitForReviewCalls.delete(waitKey);
  }
}

async function waitForReviewLoop(
  context: McpToolContext,
  args: Record<string, unknown>,
  page: { id: string; workspaceId: string },
) {
  const ctx = context.ctx;
  const until =
    args.until === "first_response" ||
    args.until === "all_threads_resolved" ||
    args.until === "timeout"
      ? args.until
      : "new_comment";
  const timeoutMs = clampNumber(args.timeout_ms, 600_000, 0, 600_000);
  const pollIntervalMs = clampNumber(args.poll_interval_ms, 1_000, 250, 5_000);
  const afterId = args.after_event_id ? String(args.after_event_id) : undefined;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const events = await reviewEvents.list(ctx, {
      workspaceId: page.workspaceId,
      pageId: page.id,
      afterId,
      limit: 200,
    });
    const threads = await comments.listForPage(ctx, {
      pageId: page.id,
      status: "all",
    });
    const openThreads = threads.filter(
      (entry) => entry.thread.status === "open",
    );
    const commentEvents = events.filter(
      (event) =>
        event.type === "comment.created" || event.type === "comment.replied",
    );

    if (
      until === "new_comment" &&
      (commentEvents.some((event) => event.type === "comment.created") ||
        (!afterId && threads.length > 0))
    ) {
      return waitResult("matched", until, events, threads);
    }
    if (
      until === "first_response" &&
      (commentEvents.length > 0 || (!afterId && threads.length > 0))
    ) {
      return waitResult("matched", until, events, threads);
    }
    if (
      until === "all_threads_resolved" &&
      threads.length > 0 &&
      openThreads.length === 0
    ) {
      return waitResult("matched", until, events, threads);
    }
    if (until === "timeout" || Date.now() >= deadline) {
      return waitResult("timeout", until, events, threads);
    }

    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

function waitForReviewKey(context: McpToolContext, pageId: string) {
  return [
    context.actor.authMode,
    context.actor.user?.id ?? context.actor.workspaceId ?? "anonymous",
    pageId,
  ].join(":");
}

function waitResult(
  status: "matched" | "timeout",
  until: string,
  events: unknown[],
  threads: unknown[],
) {
  return {
    status,
    until,
    events,
    threads,
    event_count: events.length,
    thread_count: threads.length,
  };
}
