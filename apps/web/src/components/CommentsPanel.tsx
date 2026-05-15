import {
  ArrowUp,
  Bot,
  Check,
  LocateFixed,
  MessageSquareText,
  MoreVertical,
  RotateCcw,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";

export type ThreadPayload = {
  thread: {
    id: string;
    selectedText: string;
    status: "open" | "resolved";
    createdAt: string;
    updatedAt?: string;
    resolvedAt?: string | null;
  };
  anchor: {
    sourceStart: number | null;
    sourceEnd: number | null;
    prefixText: string;
    suffixText: string;
    contentHash: string;
    renderedDomPath?: string | null;
    kind?: "text" | "point";
    surface?: "prose" | "html";
    selector?: AnchorSelector | null;
    confidence?: "active" | "reanchored" | "fuzzy" | "manual" | "stale";
  };
  replies: Array<{
    id: string;
    body: string;
    authorType: "user" | "guest" | "agent";
    authorDisplayName: string | null;
    guestName: string | null;
    agentName: string | null;
    agentModel: string | null;
    agentSessionId: string | null;
    createdAt: string;
  }>;
};

type AnchorSelector = {
  quote?: {
    exact: string;
    prefix: string;
    suffix: string;
  };
  position?: {
    sourceStart: number | null;
    sourceEnd: number | null;
    renderedStart?: number | null;
    renderedEnd?: number | null;
  };
  element?: {
    path: string | null;
    fingerprint?: string | null;
    tag?: string | null;
    id?: string | null;
    className?: string | null;
    role?: string | null;
    ariaLabel?: string | null;
    text?: string | null;
    alt?: string | null;
    title?: string | null;
  };
  point?: {
    x: number;
    y: number;
    coordinateSpace: "document" | "element";
    elementPath?: string | null;
  };
  documentPoint?: {
    x: number;
    y: number;
    coordinateSpace: "document";
  };
  textHit?: {
    exact: string;
    prefix: string;
    suffix: string;
    renderedStart?: number | null;
    renderedEnd?: number | null;
  };
  nearbyText?: string;
};

export type ThreadStats = {
  open: number;
  resolved: number;
  total: number;
};

type CommentsPanelProps = {
  workspaceId: string;
  pageId: string;
  contentHash: string;
  sourceType: "markdown" | "mdx" | "html";
  guestNameRequired?: boolean;
  /** Display name of the current actor; used in the draft header and as a
   *  fallback for user-authored replies until the API plumbs author names. */
  currentUserName?: string;
  /** Filter applied to the in-page comments rail. */
  tabFilter: "open" | "resolved" | "all";
  activeThreadId?: string | null;
  onActiveThreadChange?: (threadId: string | null) => void;
  onThreadStats?: (stats: ThreadStats) => void;
  railExpanded?: boolean;
  desktopRail?: boolean;
  onRequestOpenDraft?: () => void;
  /**
   * Threads serialized into the page on the server so the margin cards paint
   * with the initial render. When provided, the initial client-side fetch is
   * skipped; subsequent reloads (after create/resolve/reply/delete) still hit
   * the API.
   */
  initialThreads?: ThreadPayload[];
};

type ThreadLayout = "margin" | "list";

/**
 * Resize a textarea to fit its content, capped at maxHeight. Internal scroll
 * kicks in beyond the cap. Called from the onInput handler so each keystroke
 * remeasures.
 */
function autoGrowTextarea(
  element: HTMLTextAreaElement,
  maxHeight: number,
): void {
  element.style.height = "auto";
  const target = Math.min(element.scrollHeight, maxHeight);
  element.style.height = `${target}px`;
  element.style.overflowY =
    element.scrollHeight > maxHeight ? "auto" : "hidden";
}

type AnchorDraft = {
  selectedText: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  renderedDomPath?: string | null;
  prefixText: string;
  suffixText: string;
  kind: "text" | "point";
  surface: "prose" | "html";
  selector: AnchorSelector | null;
  confidence: "active" | "reanchored" | "fuzzy" | "manual" | "stale";
};

type ViewportRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const FLASH_DURATION_MS = 1200;

export function CommentsPanel({
  workspaceId,
  pageId,
  contentHash,
  sourceType,
  guestNameRequired = false,
  currentUserName = "Reviewer",
  tabFilter,
  activeThreadId = null,
  onActiveThreadChange,
  onThreadStats,
  railExpanded = true,
  desktopRail = true,
  onRequestOpenDraft,
  initialThreads,
}: CommentsPanelProps) {
  const [threads, setThreads] = useState<ThreadPayload[]>(
    () => initialThreads ?? [],
  );
  const threadsLoadedRef = useRef(initialThreads !== undefined);
  const latestDraftKeyRef = useRef(0);
  const draftViewportRectRef = useRef<ViewportRect | null>(null);
  const draftTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusDraftOnExpandRef = useRef(false);
  const [draftTriggerRect, setDraftTriggerRect] = useState<ViewportRect | null>(
    null,
  );
  const htmlThreadRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const [selectedText, setSelectedText] = useState("");
  const [anchorDraft, setAnchorDraft] = useState<AnchorDraft | null>(null);
  const [temporaryLocatedThreadId, setTemporaryLocatedThreadId] = useState<
    string | null
  >(null);
  const locateTimeoutRef = useRef<number | null>(null);
  const [htmlRectTick, setHtmlRectTick] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [creatingComment, setCreatingComment] = useState(false);
  const [pendingReplyIds, setPendingReplyIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openMenuThreadId, setOpenMenuThreadId] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");

  const openThreads = useMemo(
    () => threads.filter((thread) => thread.thread.status === "open"),
    [threads],
  );
  const resolvedThreads = useMemo(
    () => threads.filter((thread) => thread.thread.status === "resolved"),
    [threads],
  );
  const visibleThreads = useMemo(
    () =>
      tabFilter === "all"
        ? [...openThreads, ...resolvedThreads]
        : tabFilter === "resolved"
          ? resolvedThreads
          : openThreads,
    [tabFilter, openThreads, resolvedThreads],
  );
  const anchoredThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.thread.status === "open" ||
          thread.thread.id === temporaryLocatedThreadId,
      ),
    [threads, temporaryLocatedThreadId],
  );
  const [expandedMarginReplies, setExpandedMarginReplies] = useState<
    Set<string>
  >(() => new Set());
  const [expandedListReplies, setExpandedListReplies] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleExpanded = useCallback(
    (threadId: string, layout: ThreadLayout) => {
      const setExpanded =
        layout === "margin" ? setExpandedMarginReplies : setExpandedListReplies;
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(threadId)) next.delete(threadId);
        else next.add(threadId);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!guestNameRequired) return;
    setGuestName(window.localStorage.getItem("vpg_guest_name") ?? "");
  }, [guestNameRequired]);

  useEffect(() => {
    return () => {
      if (locateTimeoutRef.current)
        window.clearTimeout(locateTimeoutRef.current);
    };
  }, []);

  const setDraftViewportRect = useCallback((rect: ViewportRect | null) => {
    draftViewportRectRef.current = rect;
    setDraftTriggerRect(rect);
  }, []);

  const clearDraft = useCallback(() => {
    latestDraftKeyRef.current += 1;
    setDraftViewportRect(null);
    focusDraftOnExpandRef.current = false;
    setSelectedText("");
    setAnchorDraft(null);
    setBody("");
    setStatus("");
  }, [setDraftViewportRect]);

  function trimmedGuestName() {
    const name = guestName.trim();
    if (name) window.localStorage.setItem("vpg_guest_name", name);
    return name;
  }

  const loadThreads = useCallback(async () => {
    const response = await fetch(
      withPageQuery(`/api/pages/${pageId}/comments?status=all`, workspaceId),
    );
    if (!response.ok) return;
    const payload = (await response.json()) as { threads: ThreadPayload[] };
    setThreads(payload.threads);
    threadsLoadedRef.current = true;
  }, [pageId, workspaceId]);

  useEffect(() => {
    // Keep collapsed rails cheap: SSR supplies counts, and full thread bodies
    // load only when the rail is opened or a specific thread is requested.
    if (threadsLoadedRef.current) return;
    if (!railExpanded && !activeThreadId) return;
    void loadThreads();
  }, [activeThreadId, loadThreads, railExpanded]);

  useEffect(() => {
    function postCommentsToFrame(iframe: HTMLIFrameElement) {
      const nonce = iframe.dataset.vpgCommentsNonce;
      if (!nonce || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage(
        {
          type: "vpg:comments-render",
          pageId,
          nonce,
          activeThreadId,
          commentMode: sourceType === "html" ? "point" : "text",
          threads: anchoredThreads.map((thread) => ({
            id: thread.thread.id,
            status: thread.thread.status,
            anchorVisible:
              thread.thread.status === "open" ||
              thread.thread.id === temporaryLocatedThreadId,
            selectedText: thread.thread.selectedText,
            replyCount: thread.replies.length,
            annotationNumber: annotationNumberForThread(thread, threads),
            isAgent: isAgentThread(thread),
            anchor: thread.anchor,
          })),
        },
        "*",
      );
    }

    function matchingHtmlFrame(source: MessageEventSource | null) {
      if (!source) return null;
      for (const iframe of document.querySelectorAll<HTMLIFrameElement>(
        "[data-vpg-html-static]",
      )) {
        if (iframe.contentWindow !== source) continue;
        return iframe;
      }
      return null;
    }

    function onMessage(event: MessageEvent) {
      const iframe = matchingHtmlFrame(event.source);
      if (!iframe) return;
      const data = event.data;
      if (!isCommentBridgeMessage(data)) return;
      if (data.pageId !== pageId) return;
      if (data.nonce !== iframe.dataset.vpgCommentsNonce) return;

      if (data.type === "vpg:comments-ready") {
        postCommentsToFrame(iframe);
        return;
      }

      if (data.type === "vpg:comment-pin") {
        if (
          !data.anchor ||
          typeof data.anchor.selectedText !== "string" ||
          (data.anchor.kind !== "point" && data.anchor.kind !== "text")
        ) {
          return;
        }
        const rect = data.rect ?? { top: 0, left: 0, width: 1, height: 1 };
        const iframeRect = iframe.getBoundingClientRect();
        setDraftViewportRect({
          top: iframeRect.top + rect.top,
          left: iframeRect.left + rect.left,
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
        });
        latestDraftKeyRef.current += 1;
        const selected = data.anchor.selectedText.trim() || "Pinned comment";
        setSelectedText(selected);
        setAnchorDraft({
          selectedText: selected,
          sourceStart: data.anchor.sourceStart,
          sourceEnd: data.anchor.sourceEnd,
          renderedDomPath: data.anchor.renderedDomPath,
          prefixText: data.anchor.prefixText,
          suffixText: data.anchor.suffixText,
          kind: data.anchor.kind,
          surface: "html",
          selector: data.anchor.selector,
          confidence: data.anchor.confidence,
        });
        setStatus("");
        return;
      }

      if (data.type === "vpg:comment-clear-draft") {
        clearDraft();
        return;
      }

      if (data.type === "vpg:comment-open") {
        if (typeof data.threadId !== "string") return;
        onActiveThreadChange?.(data.threadId);
        window.dispatchEvent(
          new CustomEvent("vpg:open-comments", {
            detail: { threadId: data.threadId },
          }),
        );
        return;
      }

      if (data.type === "vpg:comment-rects") {
        const next = new Map<string, DOMRect>();
        const iframeRect = iframe.getBoundingClientRect();
        for (const [threadId, rect] of Object.entries(data.rects)) {
          next.set(
            threadId,
            new DOMRect(
              iframeRect.left + rect.left,
              iframeRect.top + rect.top,
              rect.width,
              rect.height,
            ),
          );
        }
        htmlThreadRectsRef.current = next;
        setHtmlRectTick((value) => value + 1);
        return;
      }

      if (data.type === "vpg:comment-anchor-update") {
        if (
          typeof data.threadId !== "string" ||
          data.kind !== "point" ||
          !data.selector
        ) {
          return;
        }
        void updateThreadAnchor(data.threadId, "html", data.selector);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    activeThreadId,
    anchoredThreads,
    clearDraft,
    onActiveThreadChange,
    pageId,
    setDraftViewportRect,
    sourceType,
    temporaryLocatedThreadId,
    threads,
  ]);

  useEffect(() => {
    for (const iframe of document.querySelectorAll<HTMLIFrameElement>(
      "[data-vpg-html-static]",
    )) {
      const nonce = iframe.dataset.vpgCommentsNonce;
      if (!nonce || !iframe.contentWindow) continue;
      iframe.contentWindow.postMessage(
        {
          type: "vpg:comments-render",
          pageId,
          nonce,
          activeThreadId,
          commentMode: sourceType === "html" ? "point" : "text",
          threads: anchoredThreads.map((thread) => ({
            id: thread.thread.id,
            status: thread.thread.status,
            anchorVisible:
              thread.thread.status === "open" ||
              thread.thread.id === temporaryLocatedThreadId,
            selectedText: thread.thread.selectedText,
            replyCount: thread.replies.length,
            annotationNumber: annotationNumberForThread(thread, threads),
            isAgent: isAgentThread(thread),
            anchor: thread.anchor,
          })),
        },
        "*",
      );
    }
  }, [
    activeThreadId,
    anchoredThreads,
    pageId,
    sourceType,
    temporaryLocatedThreadId,
    threads,
  ]);

  useEffect(() => {
    if (!threadsLoadedRef.current && initialThreads === undefined) return;
    const stats = {
      open: openThreads.length,
      resolved: resolvedThreads.length,
      total: threads.length,
    };
    onThreadStats?.(stats);
    window.dispatchEvent(
      new CustomEvent("vpg:comments-stats", { detail: stats }),
    );
  }, [
    initialThreads,
    threads,
    openThreads.length,
    resolvedThreads.length,
    onThreadStats,
  ]);

  useEffect(() => {
    function captureSelectionDraft() {
      if (sourceType === "html") return;
      const article = document.querySelector<HTMLElement>("[data-vpg-prose]");
      if (!article) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
        return;
      const range = selection.getRangeAt(0);
      if (!article.contains(range.commonAncestorContainer)) return;
      const rawText = selection.toString();
      const text = rawText.trim();
      if (!text) return;
      const offsets = offsetsForRange(article, range);
      if (!offsets) return;
      const leadingWhitespace = rawText.length - rawText.trimStart().length;
      const trailingWhitespace = rawText.length - rawText.trimEnd().length;
      const startOffset = offsets.start + leadingWhitespace;
      const endOffset = Math.max(startOffset, offsets.end - trailingWhitespace);
      const rect = firstVisibleRangeRect(range);
      if (!rect) return;
      const rootText = article.textContent ?? "";
      const prefixText = rootText.slice(
        Math.max(0, startOffset - 120),
        startOffset,
      );
      const suffixText = rootText.slice(endOffset, endOffset + 120);
      const domPath = domPathForNode(range.commonAncestorContainer);

      setDraftViewportRect({
        top: rect.top,
        left: rect.left,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      });
      latestDraftKeyRef.current += 1;
      setSelectedText(text);
      setAnchorDraft({
        selectedText: text,
        sourceStart: startOffset,
        sourceEnd: endOffset,
        renderedDomPath: domPath,
        prefixText,
        suffixText,
        kind: "text",
        surface: "prose",
        selector: {
          quote: { exact: text, prefix: prefixText, suffix: suffixText },
          position: {
            sourceStart: startOffset,
            sourceEnd: endOffset,
            renderedStart: startOffset,
            renderedEnd: endOffset,
          },
          element: { path: domPath },
        },
        confidence: "active",
      });
      setStatus("");
    }

    function onMouseUp(event: MouseEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest(
          ".thread-card, .comments-rail, [data-radix-popper-content-wrapper]",
        )
      ) {
        return;
      }
      window.setTimeout(captureSelectionDraft, 0);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== "Shift" && !event.shiftKey) return;
      window.setTimeout(captureSelectionDraft, 0);
    }

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener(
      "vpg:capture-comment-selection",
      captureSelectionDraft,
    );
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener(
        "vpg:capture-comment-selection",
        captureSelectionDraft,
      );
    };
  }, [sourceType]);

  // Click-outside closes the draft composer immediately, matching native text
  // selection behavior across Markdown, MDX, and HTML previews.
  useEffect(() => {
    if (!selectedText) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Clicks inside the draft card itself never close it.
      const draftCard = document.querySelector(
        '[data-vpg-thread-card="__draft__"]',
      );
      if (draftCard?.contains(target)) return;
      // Clicks inside any thread card / rail / popover are also fine —
      // the user might be navigating the comments UI.
      if (
        target instanceof Element &&
        (target.closest("[data-radix-popper-content-wrapper]") ||
          target.closest(".comment-draft-affordance") ||
          target.closest(".comments-rail") ||
          target.closest(".thread-card") ||
          target.closest(".comments-toggle"))
      ) {
        return;
      }
      window.getSelection()?.removeAllRanges();
      clearDraft();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [selectedText, clearDraft]);

  useEffect(() => {
    if (!railExpanded || !selectedText || !focusDraftOnExpandRef.current)
      return;
    focusDraftOnExpandRef.current = false;
    window.requestAnimationFrame(() => {
      draftTextareaRef.current?.focus();
    });
  }, [railExpanded, selectedText]);

  // Re-stamp marks + mobile inline icons in the doc whenever the thread list
  // changes. Unresolved marks render a persistent tint (yellow for human,
  // teal for agent). Resolved marks render transparent; they only flash when
  // navigated to from the sheet.
  useEffect(() => {
    const article = document.querySelector<HTMLElement>("[data-vpg-prose]");
    if (!article) return;

    for (const mark of [
      ...article.querySelectorAll("mark[data-vpg-comment-mark]"),
    ]) {
      mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    }
    for (const icon of [
      ...article.querySelectorAll("button[data-vpg-comment-icon]"),
    ]) {
      icon.remove();
    }
    for (const visual of [
      ...article.querySelectorAll("[data-vpg-comment-visual]"),
    ]) {
      visual.remove();
    }
    article.normalize();

    for (const thread of anchoredThreads) {
      if (!thread.thread.selectedText) continue;
      if (thread.anchor.kind === "point") {
        if (thread.anchor.surface !== "html") {
          anchorVisual(
            article,
            thread,
            annotationNumberForThread(thread, threads),
          );
        }
      } else {
        const anchored = anchorMark(
          article,
          thread.thread.selectedText,
          thread.thread.id,
          thread.anchor,
          thread.thread.status === "resolved",
          isAgentThread(thread),
          thread.replies.length,
        );
        if (!anchored && thread.thread.status === "open") {
          anchorFallbackVisual(
            article,
            thread,
            annotationNumberForThread(thread, threads),
          );
        }
      }
    }
  }, [anchoredThreads, threads]);

  // Delegated click handler on the doc: clicking a highlight or a mobile
  // inline icon focuses the thread + opens the sheet.
  useEffect(() => {
    const article = document.querySelector<HTMLElement>("[data-vpg-prose]");
    if (!article) return;
    function onClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const icon = target.closest<HTMLButtonElement>(
        "button[data-vpg-comment-icon]",
      );
      if (icon) {
        const threadId = icon.dataset.vpgCommentIcon;
        if (!threadId) return;
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("vpg:open-comments", { detail: { threadId } }),
        );
        onActiveThreadChange?.(threadId);
        flashThreadMark(threadId);
        return;
      }

      const mark = target.closest<HTMLElement>("mark[data-vpg-comment-mark]");
      const visual = target.closest<HTMLElement>("[data-vpg-comment-visual]");
      if (!mark && !visual) return;
      const threadId =
        mark?.dataset.vpgCommentMark ?? visual?.dataset.vpgCommentVisual;
      if (!threadId) return;
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent("vpg:open-comments", { detail: { threadId } }),
      );
      onActiveThreadChange?.(threadId);
      flashThreadMark(threadId);
    }
    article.addEventListener("click", onClick);
    return () => article.removeEventListener("click", onClick);
  }, [onActiveThreadChange]);

  // Active mark visual emphasis follows activeThreadId.
  useEffect(() => {
    const article = document.querySelector<HTMLElement>("[data-vpg-prose]");
    if (!article) return;
    for (const mark of article.querySelectorAll<HTMLElement>(
      "mark[data-vpg-comment-mark]",
    )) {
      mark.classList.toggle(
        "is-active",
        mark.dataset.vpgCommentMark === activeThreadId,
      );
    }
  }, [activeThreadId, threads]);

  // Y-anchor the margin cards to their marks' viewport positions with
  // collision stacking. We update each card's `transform: translateY(...)`
  // directly via DOM mutation — no React state, no CSS transition — so cards
  // track scroll perfectly (Google Docs style). React only re-renders when
  // the thread list itself changes.
  useLayoutEffect(() => {
    const container = listRef.current;
    if (!container) return;

    let frame = 0;
    function recompute() {
      const node = listRef.current;
      if (!node) return;
      const containerRect = node.getBoundingClientRect();
      type Measurement = {
        y: number;
        height: number;
        el: HTMLElement;
      };
      const measurements: Measurement[] = [];
      const seen = new Set<HTMLElement>();

      // Margin cards anchor only to OPEN threads. A single comment anchor can
      // span multiple inline DOM nodes, so position from the first visible
      // segment rather than assuming one mark element per thread.
      for (const thread of openThreads) {
        const markRect =
          htmlThreadRectsRef.current.get(thread.thread.id) ??
          getThreadMarkRect(thread.thread.id);
        const card = node.querySelector<HTMLElement>(
          `[data-vpg-thread-card="${cssEscape(thread.thread.id)}"]`,
        );
        if (!card) continue;
        card.style.maxHeight = "";
        if (!markRect) {
          card.style.visibility = "hidden";
          continue;
        }
        const naturalY = markRect.top - containerRect.top;
        measurements.push({
          y: naturalY,
          height: card.offsetHeight,
          el: card,
        });
        seen.add(card);
      }

      // The draft card (if any) anchors to the pin viewport rect captured
      // when the reviewer created the draft.
      const draftCard = node.querySelector<HTMLElement>(
        `[data-vpg-thread-card="__draft__"]`,
      );
      if (draftCard && draftViewportRectRef.current) {
        draftCard.style.maxHeight = "";
        try {
          const rect = draftViewportRectRef.current;
          if (rect.top !== 0 || rect.left !== 0) {
            const naturalY = rect.top - containerRect.top;
            measurements.push({
              y: naturalY,
              height: draftCard.offsetHeight,
              el: draftCard,
            });
            seen.add(draftCard);
          }
        } catch {
          // Range may have become detached; ignore.
        }
      }

      // Hide any straggler card whose thread isn't in openThreads anymore.
      for (const card of node.querySelectorAll<HTMLElement>(
        ".thread-card.is-anchored",
      )) {
        if (!seen.has(card)) card.style.visibility = "hidden";
      }

      measurements.sort((a, b) => a.y - b.y);
      const gap = 10;
      let cursor = -Infinity;
      for (const item of measurements) {
        // Round to integer pixels — sub-pixel transforms on a GPU-composited
        // layer jitter between frames as the source rect floats by ±0.5px.
        const stackTop = cursor === -Infinity ? 0 : cursor + gap;
        const edgeAdjustedTop = Math.round(
          Math.max(stackTop, item.y < 0 ? 0 : item.y),
        );
        item.el.style.transform = `translate3d(0, ${edgeAdjustedTop}px, 0)`;
        item.el.style.maxHeight = "";
        item.el.style.visibility = "visible";
        cursor = edgeAdjustedTop + item.height;
      }
      node.style.minHeight =
        cursor === -Infinity ? "" : `${Math.ceil(cursor + gap)}px`;
    }

    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recompute);
    }
    // Run the initial layout synchronously — inside useLayoutEffect, before
    // the browser paints. Deferring to rAF lets React commit the un-positioned
    // draft card (`top:0; left:0`), which paints once at the wrong spot and
    // then jumps to the right position on the next frame. Scroll/resize keep
    // using `schedule()` for rAF batching.
    recompute();

    const article = document.querySelector("[data-vpg-prose]");
    const resizeObserver = new ResizeObserver(schedule);
    if (article) resizeObserver.observe(article);
    for (const iframe of document.querySelectorAll("[data-vpg-html-static]")) {
      resizeObserver.observe(iframe);
    }
    resizeObserver.observe(container);
    // `capture: true` so we react to scrolls happening on any scroll
    // container in the tree, not just the window. Otherwise cards stay
    // pinned in viewport when the surrounding layout owns the scroll.
    window.addEventListener("scroll", schedule, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", schedule);

    let mutationObserver: MutationObserver | null = null;
    if (article) {
      mutationObserver = new MutationObserver(schedule);
      mutationObserver.observe(article, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [
    expandedMarginReplies,
    openThreads,
    railExpanded,
    selectedText,
    htmlRectTick,
  ]);

  async function createComment() {
    if (creatingComment) return;
    if (!selectedText) {
      setStatus("Select text in the document first.");
      return;
    }
    if (!body.trim()) {
      setStatus("Write a comment first.");
      return;
    }
    const nextGuestName = guestNameRequired ? trimmedGuestName() : null;
    if (guestNameRequired && !nextGuestName) {
      setStatus("Enter your name before commenting.");
      return;
    }

    setCreatingComment(true);
    setStatus("");
    try {
      const response = await fetch(
        withPageQuery(`/api/pages/${pageId}/comments`, workspaceId),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            body,
            guest_name: nextGuestName,
            anchor: {
              selected_text: selectedText,
              source_start: anchorDraft?.sourceStart ?? null,
              source_end: anchorDraft?.sourceEnd ?? null,
              rendered_dom_path: anchorDraft?.renderedDomPath ?? null,
              prefix_text: anchorDraft?.prefixText ?? "",
              suffix_text: anchorDraft?.suffixText ?? "",
              content_hash: contentHash,
              anchor_kind: anchorDraft?.kind ?? "text",
              surface: anchorDraft?.surface ?? "prose",
              selector: anchorDraft?.selector ?? null,
              confidence: anchorDraft?.confidence ?? "active",
            },
          }),
        },
      );

      if (!response.ok) {
        setStatus("Comment didn't send. Try again.");
        return;
      }
      const created = (await response.json()) as ThreadPayload;
      clearDraft();
      setThreads((current) => [
        ...current.filter((thread) => thread.thread.id !== created.thread.id),
        created,
      ]);
      onActiveThreadChange?.(created.thread.id);
      window.setTimeout(() => flashThreadMark(created.thread.id), 0);
    } finally {
      setCreatingComment(false);
    }
  }

  async function resolveThread(threadId: string) {
    const previous = threads;
    const now = new Date().toISOString();
    setStatus("");
    setTemporaryLocatedThreadId((current) =>
      current === threadId ? null : current,
    );
    if (htmlThreadRectsRef.current.has(threadId)) {
      const nextRects = new Map(htmlThreadRectsRef.current);
      nextRects.delete(threadId);
      htmlThreadRectsRef.current = nextRects;
      setHtmlRectTick((value) => value + 1);
    }
    setThreads((current) =>
      current.map((thread) =>
        thread.thread.id === threadId
          ? {
              ...thread,
              thread: {
                ...thread.thread,
                status: "resolved",
                resolvedAt: now,
              },
            }
          : thread,
      ),
    );
    const response = await fetch(
      withPageQuery(`/api/comment-threads/${threadId}/resolve`, workspaceId),
      { method: "POST" },
    );
    if (response.ok) {
      await loadThreads();
      return;
    }
    setThreads(previous);
    setStatus("Resolve failed. Try again.");
  }

  async function reopenThread(threadId: string) {
    const previous = threads;
    setStatus("");
    setThreads((current) =>
      current.map((thread) =>
        thread.thread.id === threadId
          ? {
              ...thread,
              thread: {
                ...thread.thread,
                status: "open",
                resolvedAt: null,
              },
            }
          : thread,
      ),
    );
    const response = await fetch(
      withPageQuery(`/api/comment-threads/${threadId}/unresolve`, workspaceId),
      { method: "POST" },
    );
    if (response.ok) {
      await loadThreads();
      return;
    }
    setThreads(previous);
    setStatus("Reopen failed. Try again.");
  }

  async function deleteThread(threadId: string) {
    const response = await fetch(
      withPageQuery(`/api/comment-threads/${threadId}`, workspaceId),
      { method: "DELETE" },
    );
    if (!response.ok) return;
    setOpenMenuThreadId(null);
    await loadThreads();
  }

  async function replyToThread(threadId: string) {
    if (pendingReplyIds.has(threadId)) return;
    const replyBody = replyBodies[threadId]?.trim();
    if (!replyBody) return;
    const nextGuestName = guestNameRequired ? trimmedGuestName() : null;
    if (guestNameRequired && !nextGuestName) return;
    setPendingReplyIds((current) => new Set(current).add(threadId));
    try {
      const response = await fetch(
        withPageQuery(`/api/comment-threads/${threadId}/replies`, workspaceId),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ body: replyBody, guest_name: nextGuestName }),
        },
      );
      if (!response.ok) return;
      setReplyBodies((current) => ({ ...current, [threadId]: "" }));
      await loadThreads();
    } finally {
      setPendingReplyIds((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
    }
  }

  async function updateThreadAnchor(
    threadId: string,
    surface: "prose" | "html",
    selector: AnchorSelector,
  ) {
    const label = selector.textHit?.exact?.trim() || "Pinned comment";
    const response = await fetch(
      withPageQuery(`/api/comment-threads/${threadId}/anchor`, workspaceId),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anchor: {
            selected_text: label,
            source_start: null,
            source_end: null,
            rendered_dom_path:
              selector.element?.path ?? selector.point?.elementPath ?? null,
            prefix_text: selector.textHit?.prefix ?? "",
            suffix_text: selector.textHit?.suffix ?? "",
            content_hash: contentHash,
            anchor_kind: "point",
            surface,
            selector,
            confidence: "manual",
          },
        }),
      },
    );
    if (response.ok) await loadThreads();
  }

  const locateThread = useCallback(
    (threadId: string) => {
      const thread = threads.find((item) => item.thread.id === threadId);
      if (locateTimeoutRef.current) {
        window.clearTimeout(locateTimeoutRef.current);
      }
      setTemporaryLocatedThreadId(threadId);
      onActiveThreadChange?.(threadId);
      window.setTimeout(() => {
        if (
          thread?.anchor.surface === "html" &&
          thread.anchor.selector?.point
        ) {
          scrollHtmlPointIntoView(thread.anchor.selector.point);
        }
        flashThreadMark(threadId);
      }, 0);
      locateTimeoutRef.current = window.setTimeout(() => {
        setTemporaryLocatedThreadId((current) =>
          current === threadId ? null : current,
        );
        locateTimeoutRef.current = null;
      }, FLASH_DURATION_MS + 500);
    },
    [onActiveThreadChange, threads],
  );

  const focusThread = useCallback(
    (threadId: string) => {
      onActiveThreadChange?.(threadId);
      flashThreadMark(threadId);
    },
    [onActiveThreadChange],
  );

  // Re-tick every 60s so relative timestamps in the cards stay fresh without
  // re-fetching threads.
  const [, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const renderThreadCard = (thread: ThreadPayload, layout: ThreadLayout) => {
    const firstReply = thread.replies[0];
    const middleReplies = thread.replies.slice(1, -1);
    const lastReply =
      thread.replies.length > 1
        ? thread.replies[thread.replies.length - 1]
        : null;
    const isResolved = thread.thread.status === "resolved";
    const isAnchored = layout === "margin";
    const isAgent = isAgentThread(thread);
    const expandedReplies =
      layout === "margin" ? expandedMarginReplies : expandedListReplies;
    const isExpanded = expandedReplies.has(thread.thread.id);
    const hiddenReplyCount = middleReplies.length;
    const shouldCollapse = !isExpanded && hiddenReplyCount > 0;
    const visibleMiddleReplies = shouldCollapse ? [] : middleReplies;
    const needsPlacement =
      thread.anchor.confidence === "fuzzy" ||
      thread.anchor.confidence === "stale";

    return (
      <article
        className={`thread-card${activeThreadId === thread.thread.id ? " is-active" : ""}${isAnchored ? " is-anchored" : ""}${isResolved ? " is-resolved" : ""}${isAgent ? " is-agent" : ""}`}
        data-vpg-thread-card={thread.thread.id}
        data-status={thread.thread.status}
        data-author-type={isAgent ? "agent" : "human"}
        data-layout={layout}
        key={thread.thread.id}
        onClick={(event) => {
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target.closest("button, input, textarea, a, [role='menuitem']")
          ) {
            return;
          }
          if (isResolved) locateThread(thread.thread.id);
          else focusThread(thread.thread.id);
        }}
      >
        <ReplyRow
          reply={firstReply}
          createdAtFallback={thread.thread.createdAt}
          currentUserName={currentUserName}
          isOpener
          rightSlot={
            <div className="thread-card-actions">
              {isResolved ? (
                <Button
                  className="thread-locate"
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => locateThread(thread.thread.id)}
                  aria-label="Show in document"
                  title="Show in document"
                >
                  <LocateFixed size={14} aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                className="thread-resolve"
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  isResolved
                    ? void reopenThread(thread.thread.id)
                    : void resolveThread(thread.thread.id)
                }
                aria-label={isResolved ? "Reopen thread" : "Resolve thread"}
                title={isResolved ? "Reopen" : "Resolve"}
              >
                {isResolved ? (
                  <RotateCcw size={14} aria-hidden="true" />
                ) : (
                  <Check size={14} aria-hidden="true" />
                )}
              </Button>
              <DropdownMenu
                open={openMenuThreadId === thread.thread.id}
                onOpenChange={(next) =>
                  setOpenMenuThreadId(next ? thread.thread.id : null)
                }
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="Thread options"
                    className="thread-menu-button"
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <MoreVertical size={14} aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    onSelect={() => void deleteThread(thread.thread.id)}
                  >
                    Delete thread
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />

        {needsPlacement ? (
          <div className="thread-anchor-status">
            Needs placement. Drag the page marker to repair the anchor.
          </div>
        ) : null}

        {hiddenReplyCount > 0 ? (
          <button
            type="button"
            className="thread-replies-toggle"
            onClick={() => toggleExpanded(thread.thread.id, layout)}
            aria-expanded={isExpanded}
          >
            <span className="thread-replies-toggle-line" aria-hidden="true" />
            <span>
              {isExpanded
                ? "Show fewer"
                : `${hiddenReplyCount} more ${hiddenReplyCount === 1 ? "reply" : "replies"}`}
            </span>
            <span className="thread-replies-toggle-line" aria-hidden="true" />
          </button>
        ) : null}

        {visibleMiddleReplies.length > 0 || lastReply ? (
          <div className="thread-replies">
            {visibleMiddleReplies.map((reply) => (
              <ReplyRow
                key={reply.id}
                reply={reply}
                createdAtFallback={reply.createdAt}
                currentUserName={currentUserName}
              />
            ))}
            {lastReply ? (
              <ReplyRow
                key={lastReply.id}
                reply={lastReply}
                createdAtFallback={lastReply.createdAt}
                currentUserName={currentUserName}
              />
            ) : null}
          </div>
        ) : null}

        <form
          className="thread-reply-composer"
          onSubmit={(event) => {
            event.preventDefault();
            const value = replyBodies[thread.thread.id]?.trim();
            if (!value || pendingReplyIds.has(thread.thread.id)) return;
            void replyToThread(thread.thread.id);
          }}
        >
          <textarea
            className="thread-reply-input"
            aria-label={`Reply to thread anchored on "${thread.thread.selectedText}"`}
            rows={1}
            value={replyBodies[thread.thread.id] ?? ""}
            onInput={(event) => autoGrowTextarea(event.currentTarget, 160)}
            onChange={(event) =>
              setReplyBodies((current) => ({
                ...current,
                [thread.thread.id]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const value = replyBodies[thread.thread.id]?.trim();
                if (value && !pendingReplyIds.has(thread.thread.id)) {
                  void replyToThread(thread.thread.id);
                }
              }
            }}
            placeholder="Reply…"
          />
          <button
            type="submit"
            className="thread-reply-send"
            disabled={
              !replyBodies[thread.thread.id]?.trim() ||
              pendingReplyIds.has(thread.thread.id)
            }
            aria-label="Send reply"
          >
            <ArrowUp size={13} aria-hidden="true" />
          </button>
        </form>
      </article>
    );
  };

  const draftAffordance =
    !railExpanded &&
    selectedText &&
    draftTriggerRect &&
    typeof document !== "undefined"
      ? createPortal(
          <button
            type="button"
            className="comment-draft-affordance"
            style={draftAffordanceStyle(draftTriggerRect)}
            onClick={() => {
              focusDraftOnExpandRef.current = true;
              onRequestOpenDraft?.();
            }}
            aria-label="Open comments to add a comment"
            title="Add comment"
          >
            <MessageSquareText size={16} aria-hidden="true" />
          </button>,
          document.body,
        )
      : null;

  const draftCard =
    selectedText && railExpanded ? (
      <article
        className="thread-card is-anchored is-draft"
        data-vpg-thread-card="__draft__"
        data-layout="margin"
        key="__draft__"
        onClick={(event) => event.stopPropagation()}
      >
        {guestNameRequired ? (
          <label className="comments-guest-name">
            <span>Your name</span>
            <Input
              autoComplete="name"
              placeholder="Jane Reviewer"
              value={guestName}
              onChange={(event) => setGuestName(event.target.value)}
            />
          </label>
        ) : null}
        <form
          className="thread-draft-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!body.trim() || creatingComment) return;
            void createComment();
          }}
        >
          <textarea
            aria-label="New comment"
            autoFocus
            className="thread-draft-input"
            ref={draftTextareaRef}
            placeholder="Add a comment..."
            rows={1}
            value={body}
            onInput={(event) => autoGrowTextarea(event.currentTarget, 220)}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                clearDraft();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (body.trim() && !creatingComment) void createComment();
              }
            }}
          />
          <button
            type="submit"
            className="thread-draft-send"
            disabled={!body.trim() || creatingComment}
            aria-label="Comment"
          >
            <ArrowUp size={13} aria-hidden="true" />
          </button>
        </form>
        {status ? <p className="comments-status">{status}</p> : null}
      </article>
    ) : null;

  const hasHtmlPreview =
    typeof document !== "undefined" &&
    document.querySelector("[data-vpg-html-static]") !== null;
  const emptyCommentsCopy =
    tabFilter === "resolved"
      ? {
          title: "No resolved comments",
          description: "Resolved threads will appear here.",
        }
      : tabFilter === "open"
        ? {
            title: "No open comments",
            description: hasHtmlPreview
              ? "Select text, right-click, or alt-click the page to comment."
              : "Select text on the page to start one.",
          }
        : {
            title: "No comments yet",
            description: "Open and resolved threads will appear here.",
          };

  const showAnchoredView = tabFilter === "open" && desktopRail;
  const showEmpty = showAnchoredView
    ? openThreads.length === 0 && !selectedText
    : visibleThreads.length === 0;

  return (
    <>
      {draftAffordance}
      <div className="comments-rail-body" aria-label="Comment threads">
        {guestNameRequired ? (
          <label className="comments-guest-name">
            <span>Your name</span>
            <Input
              autoComplete="name"
              placeholder="Jane Reviewer"
              value={guestName}
              onChange={(event) => setGuestName(event.target.value)}
            />
          </label>
        ) : null}
        {status ? <p className="comments-status">{status}</p> : null}
        {showEmpty ? (
          <div className="comments-empty">
            <MessageSquareText size={24} aria-hidden="true" />
            <strong>{emptyCommentsCopy.title}</strong>
            <span>{emptyCommentsCopy.description}</span>
          </div>
        ) : showAnchoredView ? (
          <div className="thread-list thread-list--rail" ref={listRef}>
            {openThreads.map((thread) => renderThreadCard(thread, "margin"))}
            {draftCard}
          </div>
        ) : (
          <div className="thread-list thread-list--list">
            {visibleThreads.map((thread) => renderThreadCard(thread, "list"))}
          </div>
        )}
      </div>
    </>
  );
}

function draftAffordanceStyle(rect: ViewportRect) {
  const gap = 8;
  const control = 34;
  const viewportWidth = window.innerWidth || 1;
  const viewportHeight = window.innerHeight || 1;
  const preferredTop = rect.top + rect.height + gap;
  const fallbackTop = rect.top - control - gap;
  const top =
    preferredTop + control <= viewportHeight - gap
      ? preferredTop
      : Math.max(gap, fallbackTop);
  const left = Math.min(
    viewportWidth - gap,
    Math.max(gap, rect.left + rect.width / 2),
  );
  return {
    left,
    top,
    transform: "translateX(-50%)",
  };
}

function withPageQuery(path: string, workspaceId: string) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("workspace_id", workspaceId);
  return `${url.pathname}${url.search}`;
}

const flashTimeouts = new Map<string, number>();

function flashThreadMark(threadId: string) {
  const marks = getThreadMarks(threadId);
  if (marks.length === 0) return;

  const firstVisibleMark =
    marks.find((mark) =>
      Array.from(mark.getClientRects()).some(
        (rect) => rect.width > 0 && rect.height > 0,
      ),
    ) ?? marks[0];
  firstVisibleMark.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "center",
  });

  const existingTimeout = flashTimeouts.get(threadId);
  if (existingTimeout) window.clearTimeout(existingTimeout);

  for (const mark of marks) mark.classList.remove("is-flashing");
  // Force a reflow so re-adding the class restarts the animation if it's already flashing.
  void firstVisibleMark.offsetWidth;
  for (const mark of marks) mark.classList.add("is-flashing");

  const timeout = window.setTimeout(() => {
    for (const mark of getThreadMarks(threadId)) {
      mark.classList.remove("is-flashing");
    }
    flashTimeouts.delete(threadId);
  }, FLASH_DURATION_MS);
  flashTimeouts.set(threadId, timeout);
}

function scrollHtmlPointIntoView(point: AnchorSelector["point"]) {
  if (!point) return;
  const iframe = document.querySelector<HTMLIFrameElement>(
    "[data-vpg-html-static]",
  );
  if (!iframe) return;
  const rect = iframe.getBoundingClientRect();
  const targetY =
    window.scrollY + rect.top + clamp01(point.y) * Math.max(1, rect.height);
  window.scrollTo({
    top: Math.max(0, targetY - window.innerHeight * 0.42),
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

function getThreadMarks(threadId: string) {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-vpg-comment-mark="${cssEscape(threadId)}"], [data-vpg-comment-visual="${cssEscape(threadId)}"]`,
    ),
  );
}

function getThreadMarkRect(threadId: string) {
  for (const mark of getThreadMarks(threadId)) {
    const rect = Array.from(mark.getClientRects()).find(
      (entry) => entry.width > 0 && entry.height > 0,
    );
    if (rect) return rect;
  }
  return null;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getReplyAuthorName(
  reply: ThreadPayload["replies"][number] | undefined,
  currentUserName: string,
) {
  if (!reply) return currentUserName;
  if (reply.agentName) return reply.agentName;
  if (reply.guestName) return reply.guestName;
  if (reply.authorDisplayName) return reply.authorDisplayName;
  if (reply.authorType === "agent") return "Agent";
  // No name captured on the reply and not an agent: fall back to the
  // current viewer's name. Should only trigger for very old records or
  // when the enrichment helper couldn't resolve the user.
  return currentUserName;
}

/**
 * Notion/Docs-style relative timestamp.
 *   < 60s          → "just now"
 *   < 60m          → "{n}m ago"
 *   < 24h          → "{n}h ago"
 *   yesterday      → "yesterday at h:mm a"
 *   < 7 days       → "{Weekday} at h:mm a"
 *   this year      → "Mon D"
 *   older          → "Mon D, YYYY"
 */
function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const deltaMs = now.getTime() - date.getTime();
  const deltaSec = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSec < 60) return "just now";
  if (deltaSec < 60 * 60) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 60 * 60 * 24) return `${Math.floor(deltaSec / 3600)}h ago`;

  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const dayDiff = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / 86_400_000,
  );

  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  if (dayDiff === 1) return `yesterday at ${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
    return `${weekday} at ${time}`;
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatAbsoluteTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type ReplyType = ThreadPayload["replies"][number];

function ReplyRow({
  reply,
  createdAtFallback,
  currentUserName,
  isOpener = false,
  rightSlot,
}: {
  reply: ReplyType | undefined;
  createdAtFallback: string;
  currentUserName: string;
  isOpener?: boolean;
  rightSlot?: ReactNode;
}) {
  const authorName = getReplyAuthorName(reply, currentUserName);
  const isAgent = reply?.authorType === "agent";
  const createdAt = reply?.createdAt ?? createdAtFallback;
  const modelMeta = isAgent
    ? [reply?.agentModel, reply?.agentSessionId].filter(Boolean).join(" · ")
    : "";
  const initials = initialsOf(authorName);

  return (
    <div
      className={`thread-reply${isOpener ? " thread-reply--opener" : ""}${isAgent ? " thread-reply--agent" : ""}`}
    >
      <span
        className={`thread-reply-avatar${isAgent ? " thread-reply-avatar--agent" : ""}`}
        aria-hidden="true"
      >
        {isAgent ? <Bot size={13} aria-hidden="true" /> : initials}
      </span>
      <div className="thread-reply-main">
        <div className="thread-reply-meta">
          <strong className="thread-reply-name">{authorName}</strong>
          {isAgent ? <span className="thread-agent-pill">AI</span> : null}
          <time
            className="thread-reply-time"
            dateTime={createdAt}
            title={formatAbsoluteTime(createdAt)}
          >
            {formatRelativeTime(createdAt)}
          </time>
        </div>
        {modelMeta ? (
          <span className="thread-reply-model">{modelMeta}</span>
        ) : null}
        <p className="thread-reply-body">{reply?.body ?? ""}</p>
      </div>
      {rightSlot ? (
        <div className="thread-reply-actions">{rightSlot}</div>
      ) : null}
    </div>
  );
}

function initialsOf(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "U";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const initials =
    parts.length === 1
      ? parts[0].slice(0, 1)
      : `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`;
  return initials.toUpperCase();
}

function anchorMark(
  root: HTMLElement,
  selectedText: string,
  threadId: string,
  anchor?: ThreadPayload["anchor"],
  isResolved = false,
  isAgent = false,
  replyCount = 0,
) {
  const rootText = root.textContent ?? "";
  const globalIndex = findAnchoredIndex(
    rootText,
    selectedText,
    anchor?.prefixText ?? "",
    anchor?.suffixText ?? "",
  );
  if (globalIndex < 0) return false;

  const segments = getTextSegmentsForRange(
    root,
    globalIndex,
    globalIndex + selectedText.length,
  );
  let lastMark: HTMLElement | null = null;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment.node.parentNode || segment.start === segment.end) continue;
    const range = document.createRange();
    range.setStart(segment.node, segment.start);
    range.setEnd(segment.node, segment.end);
    const mark = document.createElement("mark");
    mark.dataset.vpgCommentMark = threadId;
    if (isResolved) mark.dataset.resolved = "true";
    mark.dataset.authorType = isAgent ? "agent" : "human";
    mark.className = "vpg-comment-mark";
    range.surroundContents(mark);
    if (index === segments.length - 1) lastMark = mark;
  }

  // Insert a mobile inline icon (count pill) once, after the full anchor.
  // Hidden on desktop via CSS — it's the touch-friendly affordance for
  // narrow viewports where there's no room for floating cards.
  if (!isResolved && lastMark) {
    const icon = document.createElement("button");
    icon.type = "button";
    icon.className = "vpg-comment-icon";
    icon.dataset.vpgCommentIcon = threadId;
    icon.dataset.authorType = isAgent ? "agent" : "human";
    icon.setAttribute(
      "aria-label",
      `${replyCount} comment${replyCount === 1 ? "" : "s"}`,
    );
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>${replyCount}</span>`;
    lastMark.insertAdjacentElement("afterend", icon);
  }
  return segments.length > 0;
}

function anchorVisual(
  root: HTMLElement,
  thread: ThreadPayload,
  annotationNumber: number,
) {
  const point = thread.anchor.selector?.point;
  if (!point) return;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "vpg-comment-visual vpg-comment-visual--point";
  el.dataset.vpgCommentVisual = thread.thread.id;
  el.dataset.authorType = isAgentThread(thread) ? "agent" : "human";
  el.dataset.kind = "point";
  el.setAttribute(
    "aria-label",
    `Annotation ${annotationNumber}: ${thread.replies.length} comment${thread.replies.length === 1 ? "" : "s"}`,
  );
  el.style.left = `${clamp01(point.x) * 100}%`;
  el.style.top = `${clamp01(point.y) * 100}%`;
  el.textContent = String(annotationNumber);
  root.append(el);
}

function anchorFallbackVisual(
  root: HTMLElement,
  thread: ThreadPayload,
  annotationNumber: number,
) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "vpg-comment-visual vpg-comment-visual--point is-fuzzy";
  el.dataset.vpgCommentVisual = thread.thread.id;
  el.dataset.kind = "point";
  el.setAttribute(
    "aria-label",
    `Annotation ${annotationNumber} needs placement`,
  );
  el.textContent = String(annotationNumber);
  el.style.left = "50%";
  el.style.top = "1rem";
  root.append(el);
}

function firstVisibleRangeRect(range: Range) {
  return (
    Array.from(range.getClientRects()).find(
      (rect) => rect.width > 0 && rect.height > 0,
    ) ?? null
  );
}

function offsetsForRange(root: HTMLElement, range: Range) {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }
  try {
    const beforeStart = document.createRange();
    beforeStart.selectNodeContents(root);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = document.createRange();
    beforeEnd.selectNodeContents(root);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    const start = beforeStart.toString().length;
    const end = beforeEnd.toString().length;
    if (end <= start) return null;
    return { start, end };
  } catch {
    return null;
  }
}

function domPathForNode(node: Node) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!(el instanceof Element)) return null;
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body && parts.length < 12) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) break;
    const tag = current.tagName.toLowerCase();
    const currentTag = current.tagName;
    const index =
      Array.from(parent.children as HTMLCollectionOf<Element>)
        .filter((child) => child.tagName === currentTag)
        .indexOf(current) + 1;
    parts.unshift(`${tag}:nth-of-type(${Math.max(1, index)})`);
    current = parent;
  }
  return parts.join(">");
}

type TextSegment = {
  node: Text;
  start: number;
  end: number;
};

function getTextSegmentsForRange(
  root: HTMLElement,
  startOffset: number,
  endOffset: number,
) {
  const segments: TextSegment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const length = node.textContent?.length ?? 0;
    const nodeStart = offset;
    const nodeEnd = offset + length;
    offset = nodeEnd;

    if (length === 0 || nodeEnd <= startOffset || nodeStart >= endOffset) {
      continue;
    }

    segments.push({
      node,
      start: Math.max(startOffset, nodeStart) - nodeStart,
      end: Math.min(endOffset, nodeEnd) - nodeStart,
    });
  }

  return segments;
}

function isAgentThread(thread: ThreadPayload) {
  return thread.replies[0]?.authorType === "agent";
}

function annotationNumberForThread(
  thread: ThreadPayload,
  allThreads: ThreadPayload[],
) {
  const visualThreads = allThreads.filter(
    (item) => item.anchor.kind === "point" || item.anchor.surface === "html",
  );
  const index = visualThreads.findIndex(
    (item) => item.thread.id === thread.thread.id,
  );
  return index >= 0 ? index + 1 : 1;
}

function findAnchoredIndex(
  text: string,
  selectedText: string,
  prefixText: string,
  suffixText: string,
) {
  if (!text || !selectedText) return -1;
  let bestIndex = text.indexOf(selectedText);
  let bestScore = bestIndex >= 0 ? 0 : -1;
  let index = bestIndex;
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - prefixText.length), index);
    const suffix = text.slice(
      index + selectedText.length,
      index + selectedText.length + suffixText.length,
    );
    const prefixScore = commonSuffixLength(prefix, prefixText);
    const suffixScore = commonPrefixLength(suffix, suffixText);
    const score = prefixScore + suffixScore;
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
    index = text.indexOf(selectedText, index + selectedText.length);
  }
  return bestIndex;
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

function commonSuffixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (
    count < limit &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  )
    count += 1;
  return count;
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function")
    return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

type CommentBridgeMessage =
  | {
      type: "vpg:comment-pin";
      pageId: string;
      nonce: string;
      rect: ViewportRect | null;
      anchor: AnchorDraft & { surface: "html" };
    }
  | {
      type: "vpg:comment-clear-draft";
      pageId: string;
      nonce: string;
    }
  | {
      type: "vpg:comments-ready";
      pageId: string;
      nonce: string;
    }
  | {
      type: "vpg:comment-open";
      pageId: string;
      nonce: string;
      threadId: string;
    }
  | {
      type: "vpg:comment-rects";
      pageId: string;
      nonce: string;
      rects: Record<string, ViewportRect>;
    }
  | {
      type: "vpg:comment-anchor-update";
      pageId: string;
      nonce: string;
      threadId: string;
      kind: "point";
      selector: AnchorSelector;
    };

function isCommentBridgeMessage(value: unknown): value is CommentBridgeMessage {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (
    data.type !== "vpg:comment-pin" &&
    data.type !== "vpg:comment-clear-draft" &&
    data.type !== "vpg:comments-ready" &&
    data.type !== "vpg:comment-open" &&
    data.type !== "vpg:comment-rects" &&
    data.type !== "vpg:comment-anchor-update"
  ) {
    return false;
  }
  return typeof data.pageId === "string" && typeof data.nonce === "string";
}
