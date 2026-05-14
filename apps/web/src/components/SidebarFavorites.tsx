import { FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type PageLite = {
  id: string;
  slugId: string;
  title: string;
};

type Props = {
  workspaceId: string;
  pages: PageLite[];
  currentPageId?: string;
  initialFavoriteIds?: string[];
};

/**
 * Favorites group. Renders the user's pinned pages above the page tree.
 * Seeded by the server so visible favorites are present on first render.
 * Pages get pinned via the star button in the page header (PageStar.tsx).
 *
 * Renders nothing when there are no favorites — the empty-state belongs
 * in the page header, not as cluttering chrome here.
 */
export function SidebarFavorites({
  workspaceId,
  pages,
  currentPageId,
  initialFavoriteIds = [],
}: Props) {
  const [favoriteIds, setFavoriteIds] = useState<string[]>(initialFavoriteIds);

  useEffect(() => {
    setFavoriteIds(initialFavoriteIds);
  }, [initialFavoriteIds, workspaceId]);

  useEffect(() => {
    function onChange(event: Event) {
      const detail = (
        event as CustomEvent<{
          workspaceId?: string;
          pageId?: string;
          favorited?: boolean;
        }>
      ).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      if (!detail?.pageId) return;
      setFavoriteIds((current) => {
        if (detail.favorited) {
          return current.includes(detail.pageId!)
            ? current
            : [...current, detail.pageId!];
        }
        return current.filter((id) => id !== detail.pageId);
      });
    }

    window.addEventListener("vpg:favorites-changed", onChange);
    return () => {
      window.removeEventListener("vpg:favorites-changed", onChange);
    };
  }, [workspaceId]);

  const pageById = useMemo(
    () => new Map(pages.map((page) => [page.id, page])),
    [pages],
  );

  if (favoriteIds.length === 0) return null;
  const items = favoriteIds
    .map((id) => pageById.get(id))
    .filter((page): page is PageLite => Boolean(page));

  if (items.length === 0) return null;

  return (
    <section className="vpg-sidebar-section">
      <header className="vpg-sidebar-section-head">
        <span className="vpg-sidebar-section-label">Favorites</span>
      </header>
      <ul className="vpg-sidebar-tree">
        {items.map((page) => (
          <li key={page.id}>
            <a
              className="vpg-sidebar-row"
              href={`/p/${page.slugId}`}
              data-active={page.id === currentPageId ? "true" : undefined}
            >
              <span className="vpg-sidebar-row-icon" aria-hidden="true">
                <FileText strokeWidth={1.9} />
              </span>
              <span className="vpg-sidebar-row-label">{page.title}</span>
              <span className="vpg-sidebar-row-trail" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
