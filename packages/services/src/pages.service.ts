// PagesService — application logic for document creation, editing, and
// version management.
//
// Each method computes `tree_version` AFTER the mutation via
// `ctx.computeTreeVersion(workspaceId)` so the envelope reflects the
// post-write navigation state (matters most for create/move/rename
// where the sidebar tree actually changes).

import type { ServiceContext, MutationEnvelope } from "./context.ts";
import type {
  PageRecord,
  PageWithSource,
  CreatePageInput,
  UpdateSourceInput,
  UpdateSourceResult,
  MovePageInput,
} from "./repo/page.repo.ts";
import { ServiceError } from "./errors.ts";
import { buildEnvelope } from "./envelope.ts";

export type ServiceOutput<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

// Resolve a page by slug_id or pg_* id transparently. Both refs are
// accepted everywhere the user/agent supplies a page reference.
export async function getByRef(
  ctx: ServiceContext,
  ref: string,
): Promise<PageWithSource | null> {
  if (!ref) return null;
  const bySlug = await ctx.repo.pages.getBySlugId(ref);
  return bySlug ?? (await ctx.repo.pages.getById(ref));
}

export async function create(
  ctx: ServiceContext,
  input: CreatePageInput,
): Promise<ServiceOutput<PageWithSource>> {
  const created = await ctx.repo.pages.create(input);
  const treeVersion = await ctx.computeTreeVersion(created.page.workspaceId);
  return {
    data: created,
    envelope: buildEnvelope({
      treeVersion,
      contentHash: created.page.contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${created.page.id}`],
    }),
  };
}

export async function updateSource(
  ctx: ServiceContext,
  input: UpdateSourceInput,
): Promise<ServiceOutput<UpdateSourceResult>> {
  const result = await ctx.repo.pages.updateSource({
    pageId: input.pageId,
    source: input.source,
    baseVersionId: input.baseVersionId,
    checkpoint: input.checkpoint,
    checkpointLabel: input.checkpointLabel,
  });
  const treeVersion = await ctx.computeTreeVersion(result.page.workspaceId);
  return {
    data: result,
    envelope: buildEnvelope({
      treeVersion,
      contentHash: result.page.contentHash,
      // Source change can flip the title (via frontmatter), so the
      // sidebar may need to refresh even though no row was added.
      navigationInvalidated: result.changed,
      changedResources: [`page:${result.page.id}`],
    }),
  };
}

export async function move(
  ctx: ServiceContext,
  input: MovePageInput,
): Promise<ServiceOutput<PageRecord>> {
  // Validate the destination folder if provided.
  if (input.folderPath) {
    const page = await ctx.repo.pages.getById(input.pageId);
    if (!page) {
      throw new ServiceError("NOT_FOUND", "Page was not found.");
    }
    const folders = await ctx.repo.workspaces.listFolders(
      page.page.workspaceId,
    );
    if (
      input.folderPath &&
      !folders.some((folder) => folder.path === input.folderPath)
    ) {
      throw new ServiceError(
        "NOT_FOUND",
        "Folder was not found in this workspace.",
      );
    }
  }
  const moved = await ctx.repo.pages.move({
    pageId: input.pageId,
    title: input.title,
    folderPath: input.folderPath,
  });
  const treeVersion = await ctx.computeTreeVersion(moved.workspaceId);
  return {
    data: moved,
    envelope: buildEnvelope({
      treeVersion,
      contentHash: moved.contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${moved.id}`],
    }),
  };
}

export async function restoreVersion(
  ctx: ServiceContext,
  input: { pageId: string; versionId: string },
): Promise<ServiceOutput<UpdateSourceResult>> {
  const page = await ctx.repo.pages.getById(input.pageId);
  if (!page) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  const version = await ctx.repo.pages.getVersionSource(
    input.pageId,
    input.versionId,
  );
  const result = await ctx.repo.pages.updateSource({
    pageId: input.pageId,
    source: version.source,
    baseVersionId: page.page.versionId,
    checkpoint: true,
    checkpointLabel: `Restored ${version.version.createdAt}`,
  });
  const treeVersion = await ctx.computeTreeVersion(result.page.workspaceId);
  return {
    data: result,
    envelope: buildEnvelope({
      treeVersion,
      contentHash: result.page.contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${result.page.id}`],
    }),
  };
}
