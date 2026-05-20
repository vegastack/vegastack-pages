// Auto-purge of soft-deleted pages older than 30 days. Invoked by the
// `0 4 * * *` cron in apps/web/src/worker.ts.
//
// We list expired ids in batches (so a backlog doesn't blow the
// Worker's CPU budget in a single tick) and call pages.hardDelete on
// each — that's the same code path admins hit when they click
// "Delete forever" from the Workspace Recovery view, so the cascade
// (D1 row + page_versions FK cascade + R2 source + rendered
// artifact cleanup) is shared.

import { audit, pages as pagesService } from "@vegastack/pages-services";
import type { ServiceContext } from "@vegastack/pages-services";

export const TRASH_TTL_DAYS = 30;
export const TRASH_PURGE_BATCH = 200;

export async function runTrashAutoPurge(
  ctx: ServiceContext,
  options: { ttlDays?: number; batchSize?: number; now?: Date } = {},
): Promise<{ purged: number; failed: number }> {
  const ttlDays = options.ttlDays ?? TRASH_TTL_DAYS;
  const batch = options.batchSize ?? TRASH_PURGE_BATCH;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
  const ids = await pagesService.listExpiredTrashedIds(ctx, {
    olderThan: cutoff.toISOString(),
    limit: batch,
  });
  let purged = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      // Look up workspace + title BEFORE hardDelete drops the row;
      // the audit record needs both. Read with includeDeleted because
      // the row's already soft-deleted by definition.
      const snapshot = await pagesService.get(ctx, id, {
        includeDeleted: true,
      });
      const result = await pagesService.hardDelete(ctx, id);
      purged += 1;
      // System-attributed audit row so admins answering "what
      // disappeared overnight?" can trace each purge back to the
      // cron and the original trash event.
      try {
        await audit.record(ctx, {
          workspaceId: result.workspaceId,
          actorUserId: null,
          action: "page.hard_deleted",
          targetType: "page",
          targetId: result.pageId,
          metadata: {
            source: "cron-auto-purge",
            ttl_days: ttlDays,
            title: snapshot?.page.title ?? null,
            deleted_at: snapshot?.page.deletedAt ?? null,
            deleted_by_user_id: snapshot?.page.deletedByUserId ?? null,
          },
        });
      } catch (auditError) {
        ctx.log("warn", "trash.purge.audit_failed", {
          page_id: id,
          error:
            auditError instanceof Error
              ? auditError.message
              : String(auditError),
        });
      }
    } catch (error) {
      failed += 1;
      ctx.log("warn", "trash.purge.hard_delete_failed", {
        page_id: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { purged, failed };
}
