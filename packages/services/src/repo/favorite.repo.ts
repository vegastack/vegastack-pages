// FavoriteRepo — narrow per-resource access for sidebar favorites.
//
// The FavoriteRecord type is owned by @vegastack/pages-core; we import
// rather than redefine so the existing in-memory service and the future
// D1 implementation share the exact same record shape.

import type { FavoriteRecord } from "@vegastack/pages-core";

export type { FavoriteRecord };

export type NewFavorite = {
  workspaceId: string;
  pageId: string;
  userId: string;
};

export type FavoriteRepo = {
  listForWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<FavoriteRecord[]>;
  // Cross-workspace listing used by command palette ranking. The in-memory
  // adapter simulates via per-workspace iteration; D1 does a single query.
  listForUser(userId: string): Promise<FavoriteRecord[]>;
  has(userId: string, pageId: string): Promise<boolean>;
  add(input: NewFavorite): Promise<FavoriteRecord>;
  // Returns true if a row was deleted, false if it didn't exist (idempotent).
  remove(userId: string, pageId: string): Promise<boolean>;
};
