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
};

type TabKey = "open" | "resolved" | "all";
const RAIL_STORAGE_KEY = "vpg_comments_rail_expanded";

function initialRailExpanded() {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function persistRailExpanded(expanded: boolean) {
  try {
    window.localStorage.setItem(RAIL_STORAGE_KEY, String(expanded));
  } catch {
    // localStorage can be unavailable in restricted contexts.
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
}: CommentsRailProps) {
  const [expanded, setExpanded] = useState(initialRailExpanded);
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
