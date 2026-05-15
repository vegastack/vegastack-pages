import { AppError } from "./errors";
import { createId, idPrefixes, makePageSlugId, slugifyTitle } from "./ids";
import type { ObjectStore } from "./object-store";

export type SourceType = "markdown" | "mdx" | "html";

export type PageRecord = {
  id: string;
  workspaceId: string;
  folderPath: string;
  title: string;
  slug: string;
  slugId: string;
  sourceType: SourceType;
  objectKeyCurrent: string;
  contentHash: string;
  versionId: string;
  createdAt: string;
  updatedAt: string;
};

export type PageVersionRecord = {
  id: string;
  pageId: string;
  workspaceId: string;
  objectKey: string;
  sourceHash: string;
  sourceType: SourceType;
  label: string | null;
  createdReason: "manual" | "time_checkpoint" | "share_milestone" | "system";
  createdAt: string;
};

export type CreatePageInput = {
  id?: string;
  workspaceId: string;
  folderPath?: string;
  title: string;
  sourceType: SourceType;
  source: string;
};

export type UpdatePageSourceInput = {
  pageId: string;
  source: string;
  baseVersionId: string;
  checkpoint?: boolean;
  checkpointLabel?: string | null;
};

export type MovePageInput = {
  pageId: string;
  title?: string;
  folderPath?: string;
};

export type PageWithSource = {
  page: PageRecord;
  source: string;
};

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extensionForSourceType(sourceType: SourceType): string {
  return sourceType === "mdx" ? "mdx" : sourceType === "html" ? "html" : "md";
}

function sourceContentType(sourceType: SourceType): string {
  return sourceType === "html"
    ? "text/html; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

export class PageService {
  private readonly pages = new Map<string, PageRecord>();
  private readonly pagesByShortId = new Map<string, string>();
  private readonly versions = new Map<string, PageVersionRecord[]>();
  private readonly sourceCache = new Map<
    string,
    { contentHash: string; body: string }
  >();

  constructor(
    private readonly objectStore: ObjectStore,
    private readonly options: { checkpointIntervalMs?: number } = {},
  ) {}

  async createPage(input: CreatePageInput): Promise<PageWithSource> {
    const now = new Date().toISOString();
    const id = input.id ?? createId(idPrefixes.page);
    const slug = slugifyTitle(input.title);
    const slugId = makePageSlugId(input.title, id);
    const shortId = slugId.slice(slugId.lastIndexOf("-") + 1);
    const folderPath = input.folderPath?.replace(/^\/+|\/+$/g, "") ?? "";
    const baseKey = `workspaces/${input.workspaceId}/pages/${folderPath ? `${folderPath}/` : ""}${slugId}`;
    const objectKeyCurrent = `${baseKey}/source/current.${extensionForSourceType(input.sourceType)}`;
    const contentHash = await sha256(input.source);
    const versionId = createId(idPrefixes.version);
    const versionKey = `${baseKey}/versions/${now.replaceAll(":", "-")}-${versionId}.${extensionForSourceType(input.sourceType)}`;

    await this.objectStore.put(objectKeyCurrent, input.source, {
      contentType: sourceContentType(input.sourceType),
    });
    await this.objectStore.put(versionKey, input.source, {
      contentType: sourceContentType(input.sourceType),
    });

    const page: PageRecord = {
      id,
      workspaceId: input.workspaceId,
      folderPath,
      title: input.title,
      slug,
      slugId,
      sourceType: input.sourceType,
      objectKeyCurrent,
      contentHash,
      versionId,
      createdAt: now,
      updatedAt: now,
    };
    const version: PageVersionRecord = {
      id: versionId,
      pageId: id,
      workspaceId: input.workspaceId,
      objectKey: versionKey,
      sourceHash: contentHash,
      sourceType: input.sourceType,
      label: "Initial version",
      createdReason: "system",
      createdAt: now,
    };

    this.pages.set(id, page);
    this.pagesByShortId.set(shortId, id);
    this.versions.set(id, [version]);
    this.sourceCache.set(objectKeyCurrent, { contentHash, body: input.source });
    this.sourceCache.set(versionKey, { contentHash, body: input.source });
    return { page, source: input.source };
  }

  async getPageBySlugId(slugId: string): Promise<PageWithSource | null> {
    const shortId = slugId.slice(slugId.lastIndexOf("-") + 1);
    const pageId = this.pagesByShortId.get(shortId);
    return pageId ? this.getPage(pageId) : null;
  }

  async getPage(pageId: string): Promise<PageWithSource | null> {
    const page = this.pages.get(pageId);
    if (!page) return null;
    const cached = this.sourceCache.get(page.objectKeyCurrent);
    if (cached?.contentHash === page.contentHash) {
      return { page, source: cached.body };
    }
    const source = await this.objectStore.get(page.objectKeyCurrent);
    if (!source) {
      throw new AppError(
        "PAGE_NOT_FOUND",
        "Page source object was not found.",
        404,
      );
    }
    this.sourceCache.set(page.objectKeyCurrent, {
      contentHash: page.contentHash,
      body: source.body,
    });
    return { page, source: source.body };
  }

  listPages(workspaceId?: string): PageRecord[] {
    const pages = [...this.pages.values()];
    return workspaceId
      ? pages.filter((page) => page.workspaceId === workspaceId)
      : pages;
  }

  movePage(input: MovePageInput): PageRecord {
    const existing = this.pages.get(input.pageId);
    if (!existing) {
      throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    }
    const title = input.title?.trim() || existing.title;
    const folderPath =
      input.folderPath === undefined
        ? existing.folderPath
        : input.folderPath.replace(/^\/+|\/+$/g, "");
    const slug = slugifyTitle(title);
    const slugId = makePageSlugId(title, existing.id);
    const updated: PageRecord = {
      ...existing,
      folderPath,
      title,
      slug,
      slugId,
      updatedAt: new Date().toISOString(),
    };
    const previousShortId = existing.slugId.slice(
      existing.slugId.lastIndexOf("-") + 1,
    );
    const nextShortId = slugId.slice(slugId.lastIndexOf("-") + 1);
    this.pagesByShortId.delete(previousShortId);
    this.pagesByShortId.set(nextShortId, existing.id);
    this.pages.set(existing.id, updated);
    return updated;
  }

  async updateSource(
    input: UpdatePageSourceInput,
  ): Promise<
    PageWithSource & { checkpointCreated: boolean; changed: boolean }
  > {
    const existing = await this.getPage(input.pageId);
    if (!existing) {
      throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    }
    if (existing.page.versionId !== input.baseVersionId) {
      throw new AppError(
        "CONFLICT",
        "Page source has changed since it was loaded.",
        409,
        {
          current_version_id: existing.page.versionId,
          current_content_hash: existing.page.contentHash,
          updated_at: existing.page.updatedAt,
        },
      );
    }

    const now = new Date().toISOString();
    const contentHash = await sha256(input.source);
    const changed = contentHash !== existing.page.contentHash;
    await this.objectStore.put(existing.page.objectKeyCurrent, input.source, {
      contentType: sourceContentType(existing.page.sourceType),
    });
    this.sourceCache.set(existing.page.objectKeyCurrent, {
      contentHash,
      body: input.source,
    });

    const previousVersions = this.versions.get(input.pageId) ?? [];
    const latestCheckpoint = previousVersions.at(-1);
    const checkpointIntervalMs =
      this.options.checkpointIntervalMs ?? 10 * 60_000;
    const autoCheckpointDue =
      latestCheckpoint &&
      contentHash !== existing.page.contentHash &&
      Date.parse(now) - Date.parse(latestCheckpoint.createdAt) >=
        checkpointIntervalMs;

    let versionId =
      changed || input.checkpoint
        ? createId(idPrefixes.version)
        : existing.page.versionId;
    let checkpointCreated = false;
    if (input.checkpoint || autoCheckpointDue) {
      const versionKey = existing.page.objectKeyCurrent.replace(
        /source\/current\.[a-z]+$/,
        `versions/${now.replaceAll(":", "-")}-${versionId}.${extensionForSourceType(existing.page.sourceType)}`,
      );
      await this.objectStore.put(versionKey, input.source, {
        contentType: sourceContentType(existing.page.sourceType),
      });
      this.sourceCache.set(versionKey, { contentHash, body: input.source });
      this.versions.set(input.pageId, [
        ...(this.versions.get(input.pageId) ?? []),
        {
          id: versionId,
          pageId: input.pageId,
          workspaceId: existing.page.workspaceId,
          objectKey: versionKey,
          sourceHash: contentHash,
          sourceType: existing.page.sourceType,
          label: input.checkpointLabel ?? null,
          createdReason: input.checkpoint ? "manual" : "time_checkpoint",
          createdAt: now,
        },
      ]);
      checkpointCreated = true;
    }

    const page = {
      ...existing.page,
      contentHash,
      versionId,
      updatedAt: now,
    };
    this.pages.set(input.pageId, page);
    return { page, source: input.source, checkpointCreated, changed };
  }

  listVersions(pageId: string): PageVersionRecord[] {
    return this.versions.get(pageId) ?? [];
  }

  async getVersionSource(
    pageId: string,
    versionId: string,
  ): Promise<{ version: PageVersionRecord; source: string }> {
    const version = (this.versions.get(pageId) ?? []).find(
      (candidate) => candidate.id === versionId,
    );
    if (!version) {
      throw new AppError("PAGE_NOT_FOUND", "Page version was not found.", 404);
    }
    const source = await this.objectStore.get(version.objectKey);
    if (!source) {
      throw new AppError(
        "PAGE_NOT_FOUND",
        "Page version source object was not found.",
        404,
      );
    }
    this.sourceCache.set(version.objectKey, {
      contentHash: version.sourceHash,
      body: source.body,
    });
    return { version, source: source.body };
  }
}
