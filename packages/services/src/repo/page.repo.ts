// PageRepo — the central repository for documents.
//
// Record types are owned by @vegastack/pages-core. The repo interface
// adds async semantics and a normalized creation API; everything else
// is a thin async wrapper.

import type {
  PageRecord,
  PageVersionRecord,
  PageWithSource,
  SourceType,
} from "@vegastack/pages-core";

export type { PageRecord, PageVersionRecord, PageWithSource, SourceType };

export type CreatePageInput = {
  id?: string;
  workspaceId: string;
  folderPath?: string;
  title: string;
  sourceType?: SourceType;
  source: string;
};

export type UpdateSourceInput = {
  pageId: string;
  source: string;
  baseVersionId: string;
  checkpoint?: boolean;
  checkpointLabel?: string | null;
};

export type UpdateSourceResult = {
  page: PageRecord;
  changed: boolean;
  checkpointCreated: boolean;
};

export type MovePageInput = {
  pageId: string;
  title?: string;
  folderPath?: string;
};

export type PageRepo = {
  // Reads.
  getById(pageId: string): Promise<PageWithSource | null>;
  getBySlugId(slugId: string): Promise<PageWithSource | null>;
  list(workspaceId?: string): Promise<PageRecord[]>;
  listVersions(pageId: string): Promise<PageVersionRecord[]>;
  getVersionSource(
    pageId: string,
    versionId: string,
  ): Promise<{ version: PageVersionRecord; source: string }>;

  // Writes.
  create(input: CreatePageInput): Promise<PageWithSource>;
  updateSource(input: UpdateSourceInput): Promise<UpdateSourceResult>;
  move(input: MovePageInput): Promise<PageRecord>;
  // Soft delete — D1 sets deleted_at; in-memory removes from the map.
  // Either way the page becomes invisible to list/get operations.
  softDelete(pageId: string): Promise<PageRecord>;

  // Maintenance. Cron-only — never called from the request path.
  pruneExpiredVersions(
    retentionDaysDefault?: number,
  ): Promise<{ prunedCount: number; changed: boolean }>;
};
