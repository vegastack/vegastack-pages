// In-memory PageRepo adapter wrapping the existing PageService.
//
// Each method delegates to the existing PageService. The PageService is
// already partly async (createPage, getPage, updateSource, etc. return
// promises because they touch the object store) and partly sync
// (listPages, movePage). The repo normalizes everything to async to
// match the eventual D1 contract.
//
// pruneExpiredVersions is included for completeness but currently lives
// outside PageService in runtime.ts; the in-memory adapter delegates to
// it via the module export. The D1 adapter implements it as a narrow
// `DELETE FROM page_versions WHERE ...` query.

import type {
  PageRepo,
  PageRecord,
  PageVersionRecord,
  PageWithSource,
  CreatePageInput,
  UpdateSourceInput,
  UpdateSourceResult,
  MovePageInput,
} from "@vegastack/pages-services";
import {
  pageService,
  pruneExpiredVersions as runtimePruneExpiredVersions,
} from "../../runtime";

export function createInMemoryPageRepo(): PageRepo {
  return {
    async getById(pageId: string): Promise<PageWithSource | null> {
      return pageService.getPage(pageId);
    },
    async getBySlugId(slugId: string): Promise<PageWithSource | null> {
      return pageService.getPageBySlugId(slugId);
    },
    async list(workspaceId?: string): Promise<PageRecord[]> {
      return pageService.listPages(workspaceId);
    },
    async listVersions(pageId: string): Promise<PageVersionRecord[]> {
      return pageService.listVersions(pageId);
    },
    async getVersionSource(
      pageId: string,
      versionId: string,
    ): Promise<{ version: PageVersionRecord; source: string }> {
      return pageService.getVersionSource(pageId, versionId);
    },
    async create(input: CreatePageInput): Promise<PageWithSource> {
      return pageService.createPage({
        id: input.id,
        workspaceId: input.workspaceId,
        folderPath: input.folderPath ?? "",
        title: input.title,
        sourceType: input.sourceType ?? "markdown",
        source: input.source,
      });
    },
    async updateSource(input: UpdateSourceInput): Promise<UpdateSourceResult> {
      const result = await pageService.updateSource({
        pageId: input.pageId,
        source: input.source,
        baseVersionId: input.baseVersionId,
        checkpoint: input.checkpoint,
        checkpointLabel: input.checkpointLabel ?? null,
      });
      return {
        page: result.page,
        changed: result.changed,
        checkpointCreated: result.checkpointCreated,
      };
    },
    async move(input: MovePageInput): Promise<PageRecord> {
      return pageService.movePage({
        pageId: input.pageId,
        title: input.title,
        folderPath: input.folderPath,
      });
    },
    async softDelete(pageId: string): Promise<PageRecord> {
      // PageService currently exposes hardDelete semantics by removing
      // the entry from the in-memory map. Both routes today rely on the
      // same operation. The D1 adapter will set deleted_at instead.
      const existing = await pageService.getPage(pageId);
      if (!existing) {
        throw new Error(`PageRepo: page ${pageId} not found`);
      }
      // No PageService.delete method exists today — historical decision.
      // Document the gap so the D1 adapter doesn't accidentally diverge.
      throw new Error(
        "PageRepo.softDelete is not yet implemented in the in-memory adapter. " +
          "No existing route depends on it. Add when wiring delete-page UX.",
      );
    },
    async pruneExpiredVersions(): Promise<{
      prunedCount: number;
      changed: boolean;
    }> {
      // The existing runtime function persists state when it prunes;
      // we wrap it here so the repo contract holds. Counts aren't
      // currently surfaced — log them via tracing later.
      const before = pageService
        .listPages()
        .reduce(
          (total, page) => total + pageService.listVersions(page.id).length,
          0,
        );
      await runtimePruneExpiredVersions();
      const after = pageService
        .listPages()
        .reduce(
          (total, page) => total + pageService.listVersions(page.id).length,
          0,
        );
      return {
        prunedCount: Math.max(0, before - after),
        changed: before !== after,
      };
    },
  };
}
