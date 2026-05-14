import { List } from "lucide-react";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type Heading = { depth: number; text: string; slug: string };

type TocPopoverProps = {
  headings: Heading[];
};

/**
 * Document outline popover. Tracks the visible heading via IntersectionObserver
 * and highlights it in the list. Click-outside / Esc / focus management are
 * handled by Radix Popover — we just supply the trigger and the content.
 */
export function TocPopover({ headings }: TocPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  useEffect(() => {
    if (headings.length === 0) return;
    const elements = headings
      .map((heading) => document.getElementById(heading.slug))
      .filter((node): node is HTMLElement => Boolean(node));
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSlug(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: [0, 0.5, 1] },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="vpg-toc-trigger"
          aria-label="Open document outline"
          data-state={open ? "open" : "closed"}
        >
          <List size={14} aria-hidden="true" />
          <span>Outline</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="vpg-toc-popover"
        role="navigation"
        aria-label="Table of contents"
        align="start"
        sideOffset={6}
      >
        <p className="vpg-toc-popover-label">On this page</p>
        <ul className="vpg-toc-list">
          {headings.map((heading) => (
            <li
              key={heading.slug}
              style={{
                paddingLeft: `${Math.max(0, heading.depth - 2) * 12}px`,
              }}
            >
              <a
                href={`#${heading.slug}`}
                className="vpg-toc-item"
                data-active={activeSlug === heading.slug ? "true" : undefined}
                onClick={() => setOpen(false)}
              >
                <span>{heading.text}</span>
              </a>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
