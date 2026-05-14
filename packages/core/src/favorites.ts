import type { PageRecord } from "./page-service";

export type FavoriteRecord = {
  userId: string;
  workspaceId: string;
  pageId: string;
  createdAt: string;
};

function favoriteKey(userId: string, pageId: string) {
  return `${userId}::${pageId}`;
}

export class FavoriteService {
  private readonly favorites = new Map<string, FavoriteRecord>();

  listForWorkspace(userId: string, workspaceId: string): FavoriteRecord[] {
    return [...this.favorites.values()]
      .filter(
        (favorite) =>
          favorite.userId === userId && favorite.workspaceId === workspaceId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  isFavorite(userId: string, pageId: string): boolean {
    return this.favorites.has(favoriteKey(userId, pageId));
  }

  add(userId: string, page: PageRecord): FavoriteRecord {
    const key = favoriteKey(userId, page.id);
    const existing = this.favorites.get(key);
    if (existing) return existing;

    const favorite: FavoriteRecord = {
      userId,
      workspaceId: page.workspaceId,
      pageId: page.id,
      createdAt: new Date().toISOString(),
    };
    this.favorites.set(key, favorite);
    return favorite;
  }

  remove(userId: string, pageId: string): boolean {
    return this.favorites.delete(favoriteKey(userId, pageId));
  }
}
