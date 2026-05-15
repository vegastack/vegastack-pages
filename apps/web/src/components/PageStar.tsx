import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import {
  dispatchPageFavoriteChange,
  persistPageFavorite,
  type FavoriteChangeDetail,
} from "../lib/page-favorites";

type Props = {
  workspaceId: string;
  pageId: string;
  slugId: string;
  title: string;
  initialFavorited?: boolean;
};

export function PageStar({
  workspaceId,
  pageId,
  slugId,
  title,
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
    dispatchPageFavoriteChange({
      workspaceId,
      pageId,
      slugId,
      title,
      favorited: next,
    });
    try {
      await persistPageFavorite(workspaceId, pageId, next);
    } catch {
      setPinned(!next);
      dispatchPageFavoriteChange({
        workspaceId,
        pageId,
        slugId,
        title,
        favorited: !next,
      });
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
