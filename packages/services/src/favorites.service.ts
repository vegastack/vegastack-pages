// FavoritesService — application logic for sidebar pinning.
//
// Pure functions over the repo registry. Every operation that mutates
// state produces a MutationEnvelope built with the POST-mutation
// `tree_version` (computed via `ctx.computeTreeVersion(workspaceId)`)
// so clients comparing the envelope against their cached tree always
// see the latest version.
//
// Plan: docs/plans/007-instant-workspace-architecture.md §F.

import type { ServiceContext, MutationEnvelope } from "./context.ts";
import type { FavoriteRecord } from "./repo/favorite.repo.ts";
import { ServiceError } from "./errors.ts";
import { buildEnvelope } from "./envelope.ts";

export type FavoriteResult = {
  favorite: FavoriteRecord | null;
  envelope: MutationEnvelope;
};

export async function add(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<FavoriteResult> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in to manage favorites.");
  }
  const page = await ctx.repo.pages.getById(input.pageId);
  if (!page) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  const favorite = await ctx.repo.favorites.add({
    workspaceId: page.page.workspaceId,
    pageId: page.page.id,
    userId: ctx.actor.userId,
  });
  // Compute tree_version AFTER the mutation so the envelope reflects
  // the new pinned state visible in the sidebar.
  const treeVersion = await ctx.computeTreeVersion(page.page.workspaceId);
  return {
    favorite,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `favorite:${page.page.id}:${ctx.actor.userId}`,
        `page:${page.page.id}`,
      ],
    }),
  };
}

export async function remove(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<FavoriteResult> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in to manage favorites.");
  }
  const page = await ctx.repo.pages.getById(input.pageId);
  if (!page) {
    throw new ServiceError("NOT_FOUND", "Page was not found.");
  }
  await ctx.repo.favorites.remove(ctx.actor.userId, page.page.id);
  const treeVersion = await ctx.computeTreeVersion(page.page.workspaceId);
  return {
    favorite: null,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `favorite:${page.page.id}:${ctx.actor.userId}`,
        `page:${page.page.id}`,
      ],
    }),
  };
}

export async function listForWorkspace(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<FavoriteRecord[]> {
  if (!ctx.actor.userId) return [];
  return ctx.repo.favorites.listForWorkspace(
    ctx.actor.userId,
    input.workspaceId,
  );
}
