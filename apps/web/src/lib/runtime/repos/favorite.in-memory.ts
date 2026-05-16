// In-memory FavoriteRepo adapter.
//
// Wraps the existing FavoriteService from packages/core. Every method
// is async per the repo contract (Promise<T>); the in-memory impl
// resolves immediately. Used today for both Node self-host and the
// transition period on Cloudflare. The D1 implementation (future)
// replaces this without touching any caller.

import type { FavoriteService } from "@vegastack/pages-core";
import type {
  FavoriteRepo,
  FavoriteRecord,
  NewFavorite,
} from "@vegastack/pages-services";
import { pageService } from "../../runtime";

export function createInMemoryFavoriteRepo(
  service: FavoriteService,
): FavoriteRepo {
  return {
    async listForWorkspace(
      userId: string,
      workspaceId: string,
    ): Promise<FavoriteRecord[]> {
      return service.listForWorkspace(userId, workspaceId);
    },
    async listForUser(userId: string): Promise<FavoriteRecord[]> {
      // The in-memory service doesn't expose cross-workspace iteration,
      // but the underlying favorites Map is logically per-user-per-page.
      // We re-derive the user's favorites by reading every workspace's
      // listForWorkspace and concatenating. O(workspaces) on each call,
      // which is fine for the existing in-memory data sizes. The D1
      // replacement is a single indexed query.
      //
      // For now, listForUser falls back to consulting pageService for
      // every favorite found across the workspaces this user touches.
      // Routes that need it should switch to the D1 adapter when paid-
      // plan replicas land — see plan §I.
      const allFavorites: FavoriteRecord[] = [];
      const pages = pageService.listPages();
      const workspaces = new Set(pages.map((page) => page.workspaceId));
      for (const workspaceId of workspaces) {
        allFavorites.push(...service.listForWorkspace(userId, workspaceId));
      }
      return allFavorites.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },
    async has(userId: string, pageId: string): Promise<boolean> {
      if (!userId) return false;
      return service.isFavorite(userId, pageId);
    },
    async add(input: NewFavorite): Promise<FavoriteRecord> {
      // FavoriteService.add wants the PageRecord (not just the id) so it
      // can stamp workspaceId on the favorite. The repo interface is
      // narrower (just NewFavorite) so we look the page up here.
      const page = await pageService.getPage(input.pageId);
      if (!page) {
        throw new Error(`PageRepo: page ${input.pageId} not found`);
      }
      return service.add(input.userId, page.page);
    },
    async remove(userId: string, pageId: string): Promise<boolean> {
      return service.remove(userId, pageId);
    },
  };
}
