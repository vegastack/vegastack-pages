import { Star } from "lucide-react";
import { useEffect, useState } from "react";

type Props = {
  workspaceId: string;
  pageId: string;
  initialFavorited?: boolean;
};

export type FavoriteChangeDetail = {
  workspaceId: string;
  pageId: string;
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

export function PageStar({
  workspaceId,
  pageId,
  initialFavorited = false,
}: Props) {
  const [pinned, setPinned] = useState(initialFavorited);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setPinned(initialFavorited);
  }, [initialFavorited, workspaceId, pageId]);

  useEffect(() => {
    function syncFavorite(event: Event) {
      const detail = (event as CustomEvent<FavoriteChangeDetail>).detail;
      if (detail?.workspaceId !== workspaceId || detail.pageId !== pageId) {
        return;
      }
      setPinned(detail.favorited);
    }
    window.addEventListener("vpg:favorites-changed", syncFavorite);
    return () =>
      window.removeEventListener("vpg:favorites-changed", syncFavorite);
  }, [workspaceId, pageId]);

  async function toggle() {
    if (pending) return;
    const next = !pinned;
    setPending(true);
    setPinned(next);
    dispatchPageFavoriteChange({ workspaceId, pageId, favorited: next });
    try {
      await persistPageFavorite(workspaceId, pageId, next);
    } catch {
      setPinned(!next);
      dispatchPageFavoriteChange({ workspaceId, pageId, favorited: !next });
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className="vpg-pheader-btn vpg-favorite-toggle"
      data-pinned={pinned ? "true" : "false"}
      aria-pressed={pinned}
      disabled={pending}
      aria-label={pinned ? "Remove from favorites" : "Add to favorites"}
      title={pinned ? "Pinned to sidebar" : "Pin to sidebar"}
      onClick={toggle}
    >
      <Star aria-hidden="true" />
    </button>
  );
}
