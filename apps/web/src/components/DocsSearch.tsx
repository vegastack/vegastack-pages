import { Command } from "cmdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

interface PagefindSubResult {
  url: string;
  title: string;
  excerpt: string;
}

interface PagefindResultData {
  url: string;
  meta: { title?: string };
  excerpt: string;
  sub_results?: PagefindSubResult[];
}

interface PagefindResult {
  id: string;
  data: () => Promise<PagefindResultData>;
}

interface PagefindAPI {
  search: (query: string) => Promise<{ results: PagefindResult[] }>;
  init?: () => Promise<void>;
}

type LoadState = "idle" | "loading" | "ready" | "unavailable";

interface ResolvedResult {
  url: string;
  title: string;
  excerpt: string;
  subResults: PagefindSubResult[];
}

const PAGEFIND_URL = "/pagefind/pagefind.js";

let pagefindPromise: Promise<PagefindAPI | null> | null = null;

type NavigatorWithUAData = Navigator & {
  userAgentData?: { platform?: string };
};

function isMacLikePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform ?? navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const IS_MAC = isMacLikePlatform();

function loadPagefind(): Promise<PagefindAPI | null> {
  if (pagefindPromise) return pagefindPromise;
  pagefindPromise = (async () => {
    try {
      const mod = (await import(
        /* @vite-ignore */ PAGEFIND_URL
      )) as PagefindAPI;
      if (typeof mod.init === "function") {
        await mod.init();
      }
      return mod;
    } catch {
      return null;
    }
  })();
  return pagefindPromise;
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ResolvedResult[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  const openSearch = useCallback(() => setOpen(true), []);
  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults([]);
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const modifier = IS_MAC ? event.metaKey : event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "/" && !open) {
        const target = event.target as HTMLElement | null;
        const isEditable =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable);
        if (!isEditable) {
          event.preventDefault();
          setOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (loadState !== "idle") return;
    setLoadState("loading");
    loadPagefind().then((api) => {
      setLoadState(api ? "ready" : "unavailable");
    });
  }, [open, loadState]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    if (loadState !== "ready") return;
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      const api = await loadPagefind();
      if (!api) {
        if (seq === searchSeq.current) {
          setLoadState("unavailable");
          setSearching(false);
        }
        return;
      }
      try {
        const { results: rawResults } = await api.search(trimmed);
        const sliced = rawResults.slice(0, 8);
        const resolved = await Promise.all(sliced.map((r) => r.data()));
        if (seq !== searchSeq.current) return;
        const mapped: ResolvedResult[] = resolved.map((data) => ({
          url: data.url,
          title: data.meta.title ?? data.url,
          excerpt: stripHtml(data.excerpt),
          subResults: data.sub_results ?? [],
        }));
        setResults(mapped);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [query, open, loadState]);

  const modifierLabel = IS_MAC ? "⌘" : "Ctrl";

  const trimmed = query.trim();
  const emptyState = useMemo(() => {
    if (loadState === "loading") return "Loading search...";
    if (loadState === "unavailable")
      return "Search index unavailable. Run pnpm build to generate it.";
    if (!trimmed) return "Type to search the documentation.";
    if (searching) return "Searching...";
    return "No matches.";
  }, [loadState, trimmed, searching]);

  const onTriggerKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.key === "ArrowDown"
      ) {
        event.preventDefault();
        openSearch();
      }
    },
    [openSearch],
  );

  return (
    <>
      <button
        type="button"
        className="docs-search-trigger"
        onClick={openSearch}
        onKeyDown={onTriggerKey}
        aria-label="Search documentation"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span className="docs-search-trigger-label">Search docs</span>
        <span className="docs-search-trigger-kbd">
          <kbd>{modifierLabel}</kbd>
          <kbd>K</kbd>
        </span>
      </button>

      {open && (
        <div
          className="docs-search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Search documentation"
        >
          <div className="docs-search-backdrop" onClick={closeSearch} />
          <div className="docs-search-panel">
            <Command
              shouldFilter={false}
              loop
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                }
              }}
            >
              <div className="docs-search-input-row">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <Command.Input
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search the docs"
                  className="docs-search-input"
                />
                <kbd className="docs-search-escape">Esc</kbd>
              </div>
              <Command.List className="docs-search-list">
                {results.length === 0 ? (
                  <Command.Empty className="docs-search-empty">
                    {emptyState}
                  </Command.Empty>
                ) : (
                  <Command.Group>
                    {results.map((result, index) => (
                      <Command.Item
                        key={`${result.url}-${index}`}
                        value={`${result.url}-${index}`}
                        onSelect={() => {
                          window.location.href = result.url;
                        }}
                        className="docs-search-item"
                      >
                        <div className="docs-search-item-head">
                          <span className="docs-search-item-title">
                            {result.title}
                          </span>
                          <span className="docs-search-item-url">
                            {result.url}
                          </span>
                        </div>
                        <p className="docs-search-item-excerpt">
                          {result.excerpt}
                        </p>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
              </Command.List>
              <div className="docs-search-footer">
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> Navigate
                </span>
                <span>
                  <kbd>↵</kbd> Open
                </span>
                <span>
                  <kbd>Esc</kbd> Close
                </span>
              </div>
            </Command>
          </div>
        </div>
      )}
    </>
  );
}
