export type FavoriteChangeDetail = {
  workspaceId: string;
  pageId: string;
  slugId?: string;
  title?: string;
  favorited: boolean;
};

export function dispatchPageFavoriteChange(detail: FavoriteChangeDetail) {
  window.dispatchEvent(new CustomEvent("vpg:favorites-changed", { detail }));
}

export async function persistPageFavorite(
  workspaceId: string,
  pageId: string,
  favorited: boolean,
) {
  const response = await fetch(
    `/api/pages/${pageId}/favorite?workspace_id=${encodeURIComponent(workspaceId)}`,
    {
      method: favorited ? "PUT" : "DELETE",
    },
  );
  if (!response.ok) throw new Error("Favorite update failed.");
}
