export type TocHeading = {
  depth: number;
  htmlId?: string;
  slug: string;
  text: string;
};

let activeObserver: IntersectionObserver | null = null;

export function tocItems(headings: TocHeading[]) {
  return headings.filter((heading) => heading.depth >= 1 && heading.depth <= 3);
}

export function tocAnchorId(heading: TocHeading) {
  return heading.htmlId ?? heading.slug;
}

export function initTocRail() {
  installTocObserver();
}

export function renderTocRail(headings: TocHeading[]) {
  const outline = document.querySelector<HTMLElement>("[data-vpg-outline]");
  const list = outline?.querySelector<HTMLOListElement>(
    "[data-vpg-outline-list]",
  );
  if (!outline || !list) return;

  const items = tocItems(headings);
  list.replaceChildren(
    ...items.map((heading) => {
      const id = tocAnchorId(heading);
      const item = document.createElement("li");
      item.className = `docs-toc-item docs-toc-depth-${heading.depth}`;
      const anchor = document.createElement("a");
      anchor.href = `#${id}`;
      anchor.dataset.tocAnchor = id;
      anchor.textContent = heading.text;
      item.append(anchor);
      return item;
    }),
  );
  outline.dataset.empty = String(items.length === 0);
  outline.setAttribute("aria-hidden", String(items.length === 0));
  installTocObserver();
}

function installTocObserver() {
  activeObserver?.disconnect();
  activeObserver = null;

  const toc = document.querySelector<HTMLElement>("[data-vpg-outline]");
  if (!toc) return;

  const anchors = Array.from(
    toc.querySelectorAll<HTMLAnchorElement>("[data-toc-anchor]"),
  );
  const pairs = anchors
    .map((anchor) => {
      const slug = anchor.dataset.tocAnchor;
      if (!slug) return null;
      const heading = document.getElementById(slug);
      return heading ? { anchor, heading } : null;
    })
    .filter(
      (pair): pair is { anchor: HTMLAnchorElement; heading: HTMLElement } =>
        pair !== null,
    );

  if (pairs.length === 0) return;

  const setActive = (slug: string | null) => {
    for (const { anchor } of pairs) {
      const isActive = anchor.dataset.tocAnchor === slug;
      anchor.parentElement?.classList.toggle("is-active", isActive);
    }
  };

  activeObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setActive(entry.target.id);
          break;
        }
      }
    },
    { rootMargin: "-15% 0% -70% 0%", threshold: 0 },
  );

  for (const { heading } of pairs) activeObserver.observe(heading);
}
