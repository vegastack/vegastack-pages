// Search-index reconciler.
//
// Runs on the 30 3 * * * cron. Walks every workspace and re-derives
// search_documents from the base tables (pages, folders,
// comment_threads). Heals any background-task drop that left the FTS
// mirror stale. Plan 011 §10.

import { search } from "@vegastack/pages-services";
import { buildServiceContext } from "./service-context";
import { getDb } from "./runtime";

export type SearchReconcilerResult = {
  workspaces: number;
  pages: number;
  folders: number;
  comments: number;
};

export async function runSearchReconciler(): Promise<SearchReconcilerResult> {
  const db = await getDb();
  if (!db) {
    return { workspaces: 0, pages: 0, folders: 0, comments: 0 };
  }

  // Privileged ctx (no cookies / no actor). Reconciler runs as the
  // system, never as a user.
  const seedCookies = { get: () => undefined } as never;
  const { ctx } = await buildServiceContext({ cookies: seedCookies });

  const result = await db
    .prepare("SELECT id FROM workspaces")
    .all<{ id: string }>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  const workspaceIds = rows.map((row) => row.id);

  // Process workspaces in bounded-concurrency batches so one bad
  // workspace can't poison the cron run. Promise.allSettled ensures
  // every workspace is attempted; failures are logged via ctx.log and
  // the totals reflect only the workspaces that succeeded.
  const totals = { workspaces: 0, pages: 0, folders: 0, comments: 0 };
  const concurrency = 4;
  for (let offset = 0; offset < workspaceIds.length; offset += concurrency) {
    const batch = workspaceIds.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      batch.map((workspaceId) =>
        search.reconcileWorkspace(ctx, { workspaceId }),
      ),
    );
    settled.forEach((entry, index) => {
      const workspaceId = batch[index]!;
      if (entry.status === "fulfilled") {
        totals.workspaces += 1;
        totals.pages += entry.value.pages;
        totals.folders += entry.value.folders;
        totals.comments += entry.value.comments;
      } else {
        ctx.log("warn", "search.reconcile.workspace.failed", {
          workspace_id: workspaceId,
          error:
            entry.reason instanceof Error
              ? entry.reason.message
              : String(entry.reason),
        });
      }
    });
  }
  return totals;
}
