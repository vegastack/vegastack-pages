import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEffect, useState } from "react";
import {
  CommentsPanel,
  type ThreadPayload,
  type ThreadStats,
} from "./CommentsPanel";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type CommentsRailProps = {
  workspaceId: string;
  pageId: string;
  contentHash: string;
  sourceType: "markdown" | "mdx" | "html";
  guestNameRequired?: boolean;
  currentUserName?: string;
  initialThreads?: ThreadPayload[];
  initialExpanded?: boolean;
};

type TabKey = "open" | "resolved" | "all";
const RAIL_STORAGE_KEY = "vpg_comments_rail_expanded";
const RAIL_COOKIE_KEY = "vpg_comments_rail";

function readStoredRailExpanded(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(RAIL_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  return null;
}

function persistRailExpanded(expanded: boolean) {
  try {
    window.localStorage.setItem(RAIL_STORAGE_KEY, String(expanded));
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  try {
    const value = expanded ? "open" : "collapsed";
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${RAIL_COOKIE_KEY}=${value}; path=/; max-age=31536000; samesite=lax${secure}`;
  } catch {
    // document.cookie can throw in sandboxed contexts.
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.commentsRail = expanded
      ? "open"
      : "collapsed";
  }
}

/**
 * In-page comments rail. The rail owns the tabs and collapsed/expanded shell;
 * CommentsPanel owns document anchors, drafts, replies, and API wiring.
 */
export function CommentsRail({
  workspaceId,
  pageId,
  contentHash,
  sourceType,
  guestNameRequired = false,
  currentUserName,
  initialThreads,
  initialExpanded = true,
}: CommentsRailProps) {
  // Seed strictly from the SSR-resolved prop so the first client render
  // matches the server HTML and React never warns about a hydration
  // mismatch. Legacy clients that have only localStorage (no cookie) are
  // reconciled below in a mount effect.
  const [expanded, setExpanded] = useState(initialExpanded);
  const [tab, setTab] = useState<TabKey>("open");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [stats, setStats] = useState<ThreadStats>({
    open: 0,
    resolved: 0,
    total: 0,
  });

  function setRailExpanded(next: boolean) {
    setExpanded(next);
    persistRailExpanded(next);
  }

  function openRailForDraft() {
    setTab("open");
    setRailExpanded(true);
  }

  function toggleRailExpanded() {
    setExpanded((current) => {
      const next = !current;
      persistRailExpanded(next);
      return next;
    });
  }

  useEffect(() => {
    // Reconcile from localStorage on mount for legacy clients that have it
    // set but no cookie yet (SSR fell back to the prop default). If
    // localStorage disagrees with the rendered state, flip and persist
    // cookie + dataset so the next navigation SSRs correctly.
    const stored = readStoredRailExpanded();
    const next = stored ?? initialExpanded;
    if (next !== expanded) setExpanded(next);
    persistRailExpanded(next);
    // Runs once; later toggles persist inline via setRailExpanded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onOpenComments(event: Event) {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      const threadId = detail?.threadId ?? null;
      setActiveThreadId(threadId);
      setRailExpanded(true);
    }
    window.addEventListener("vpg:open-comments", onOpenComments);
    return () =>
      window.removeEventListener("vpg:open-comments", onOpenComments);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      const isTypingInField =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key === "m" || event.key === "M")
      ) {
        event.preventDefault();
        toggleRailExpanded();
        return;
      }

      if (event.key !== "Escape" || !expanded || isTypingInField) return;
      if (activeThreadId) {
        setActiveThreadId(null);
        event.preventDefault();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, activeThreadId]);

  const tabs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "open", label: "Open", count: stats.open },
    { key: "resolved", label: "Resolved", count: stats.resolved },
    { key: "all", label: "All", count: stats.total },
  ];

  return (
    <aside
      className="comments-rail"
      data-collapsed={String(!expanded)}
      aria-label="Comments"
    >
      {!expanded ? (
        <button
          type="button"
          className="comments-rail-collapsed"
          onClick={() => setRailExpanded(true)}
          aria-label={
            stats.open > 0
              ? `Expand comments, ${stats.open} open`
              : "Expand comments"
          }
        >
          <span className="comments-rail-collapsed-icon">
            <ChevronsLeft size={17} aria-hidden="true" />
          </span>
          <span className="comments-rail-collapsed-count">{stats.open}</span>
        </button>
      ) : (
        <>
          <header className="comments-rail-header">
            <div className="comments-rail-title-row">
              <button
                type="button"
                className="comments-rail-collapse"
                onClick={() => setRailExpanded(false)}
                aria-label="Collapse comments"
              >
                <ChevronsRight size={16} aria-hidden="true" />
              </button>
              <h2 className="comments-rail-title">Comments</h2>
            </div>
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as TabKey)}
              aria-label="Filter comments"
              className="comments-rail-tabs"
            >
              <TabsList>
                {tabs.map((entry) => (
                  <TabsTrigger
                    key={entry.key}
                    value={entry.key}
                    data-vpg-active={entry.key === tab ? "true" : "false"}
                  >
                    <span>{entry.label}</span>
                    <span className="comments-rail-tab-count">
                      {entry.count}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </header>
        </>
      )}
      <CommentsPanel
        workspaceId={workspaceId}
        pageId={pageId}
        contentHash={contentHash}
        sourceType={sourceType}
        guestNameRequired={guestNameRequired}
        currentUserName={currentUserName}
        tabFilter={tab}
        activeThreadId={activeThreadId}
        onActiveThreadChange={setActiveThreadId}
        onThreadStats={setStats}
        railExpanded={expanded}
        onRequestOpenDraft={openRailForDraft}
        initialThreads={initialThreads}
      />
    </aside>
  );
}
