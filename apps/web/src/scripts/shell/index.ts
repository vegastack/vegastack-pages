// VegaStack Pages shell controller.
//
// Replaces ClientRouter for /p/* and /f/* navigation. On click, fetches a
// DocumentPayload from /api/workspaces/:wid/documents/{page,folder}/:ref,
// swaps #vpg-document innerHTML, updates the header/breadcrumb DOM, and
// pushes a history entry. Then dispatches astro:page-load so existing
// listeners (PageHeader.astro:457, Sidebar.astro:623, etc.) re-init the
// same way they would under ClientRouter.
//
// Falls back to a full browser navigation when:
//   - The link target isn't /p/* or /f/*
//   - The payload fetch fails (4xx/5xx/network)
//   - The user modifier-clicks (cmd/ctrl/shift/alt/middle-click)
//   - The link has target= or download attributes
//   - The link is inside a <form>
//
// Plan: docs/plans/007-instant-workspace-architecture.md §6.3-§6.4.

import type {
  DocumentPayload,
  ShellNavigateOptions,
  ShellNavigateResult,
} from "./types";

// The page-editor-controller exposes a cleanup callback on window. The
// shell calls it before each swap so the previous editor instance
// detaches cleanly. Type the augmentation so TypeScript trusts the
// access.
declare global {
  interface Window {
    __vpgPageEditorControllerCleanup?: (() => void) | undefined;
  }
}

type ShellState = {
  workspaceId: string;
  currentPayload: DocumentPayload;
  // Bookmark for D1 Sessions API (Cloudflare paid plan + replicas).
  // Sent as x-vpg-d1-bookmark; backend echoes the new bookmark.
  // No-op on Node self-host (server omits the header).
  d1Bookmark: string | null;
};

const SHELL_PATH_RE = /^\/(?:p|f)\/[^/]+/;
const PAGE_PAYLOAD_RE = /^\/p\/([^/?#]+)/;
const FOLDER_PAYLOAD_RE = /^\/f\/([^/?#]+)/;

let state: ShellState | null = null;
let booted = false;

// Public API. Mount the shell with the SSR-emitted initial payload so the
// controller starts in sync with what the user is already looking at.
// Calling more than once is a no-op.
export function bootShell(initial: DocumentPayload): void {
  if (booted) return;
  booted = true;

  state = {
    workspaceId: initial.workspace.id,
    currentPayload: initial,
    d1Bookmark: readBookmark(),
  };

  document.addEventListener("click", onClick, { capture: true });
  window.addEventListener("popstate", onPopState);

  // Expose for debugging + for forms/scripts that need to trigger shell nav.
  Object.defineProperty(window, "__vpgShell", {
    value: {
      navigate,
      getState: () => state,
      version: 1,
    },
    writable: false,
  });
}

// Programmatic navigation. Same code path as a link click.
export async function navigate(
  href: string,
  opts: ShellNavigateOptions = {},
): Promise<ShellNavigateResult> {
  if (!state) {
    window.location.assign(href);
    return { ok: true, status: "fallback" };
  }
  const url = new URL(href, window.location.href);
  if (!shouldHandle(url)) {
    window.location.assign(href);
    return { ok: true, status: "fallback" };
  }
  try {
    const payload = await fetchPayload(
      state.workspaceId,
      url,
      state.d1Bookmark,
    );
    if (!payload) {
      // Server says no (404/403/etc). Let the browser do a full nav so the
      // SSR error page renders normally.
      window.location.assign(href);
      return { ok: true, status: "fallback" };
    }
    // HTML-source pages render inside a sandboxed iframe whose srcdoc is
    // assembled at SSR with per-request CSP nonces. Inserting the raw
    // HTML source into the parent document would (a) lose sandboxing and
    // (b) execute scripts in the parent origin — a stored-XSS path for
    // any editable HTML page. Force full-page navigation so the new
    // page's SSR pipeline reapplies the sandbox + nonces.
    if (payload.kind === "page" && payload.page?.source_type === "html") {
      window.location.assign(href);
      return { ok: true, status: "fallback" };
    }
    swapDocument(payload);
    state.currentPayload = payload;
    if (opts.replace) {
      history.replaceState(
        { vpgShell: true, payload },
        "",
        url.pathname + url.search + url.hash,
      );
    } else {
      history.pushState(
        { vpgShell: true, payload },
        "",
        url.pathname + url.search + url.hash,
      );
    }
    document.title = payload.header.title;
    // Dispatch the same event ClientRouter would fire so existing
    // initializers (PageHeader, Sidebar, prose enhancers, page-editor)
    // re-bind to the new DOM.
    document.dispatchEvent(new CustomEvent("astro:page-load"));
    return { ok: true, status: "swapped" };
  } catch (error) {
    // Failure path the audit flagged: previously this returned to the
    // (void-returning) click handler which simply ignored the failure,
    // leaving the user on the old page after preventDefault. Force a
    // full-page navigation as the safe fallback for any swap/parse
    // exception too.
    try {
      window.location.assign(href);
    } catch {
      /* hard navigation already underway — ignore */
    }
    return { ok: false, status: "error", error: error as Error };
  }
}

function onClick(event: MouseEvent) {
  if (!state) return;
  // Honor modifier-clicks and middle/right-clicks — they expect a new tab
  // or default browser behaviour.
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!anchor) return;
  if (anchor.hasAttribute("download")) return;
  if (anchor.getAttribute("target") === "_blank") return;
  if (anchor.closest("form")) return;
  if (anchor.dataset.vpgShellSkip === "true") return;

  const href = anchor.getAttribute("href");
  if (!href) return;
  // Skip hashes-only and javascript: links.
  if (href.startsWith("#") || href.toLowerCase().startsWith("javascript:"))
    return;

  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return;
  if (!shouldHandle(url)) return;

  event.preventDefault();
  void navigate(url.pathname + url.search + url.hash);
}

function onPopState(event: PopStateEvent) {
  if (!state) return;
  const persisted = (event.state ?? null) as {
    vpgShell?: boolean;
    payload?: DocumentPayload;
  } | null;
  if (persisted?.vpgShell && persisted.payload) {
    // Optimistic swap: render the cached payload immediately so back/
    // forward feels instant, then revalidate against the server. A
    // permission revoke, password rotation, or cross-tab content
    // update could invalidate the cached payload; the background
    // refetch corrects the DOM when that happens.
    swapDocument(persisted.payload);
    state.currentPayload = persisted.payload;
    document.title = persisted.payload.header.title;
    document.dispatchEvent(new CustomEvent("astro:page-load"));
    const url = new URL(window.location.href);
    void revalidateAfterPopState(url, persisted.payload);
    return;
  }
  // Back/forward to a non-shell entry — let the browser handle it.
  window.location.reload();
}

async function revalidateAfterPopState(
  url: URL,
  cachedPayload: DocumentPayload,
): Promise<void> {
  if (!state) return;
  try {
    const fresh = await fetchPayload(state.workspaceId, url, state.d1Bookmark);
    if (!fresh) {
      // Server says no (404/403). Hard-navigate so SSR renders the
      // appropriate error page or login flow.
      window.location.assign(url.pathname + url.search + url.hash);
      return;
    }
    // Cheap structural fingerprint: skip the second swap when nothing
    // changed so the DOM doesn't flicker.
    const cachedKey = `${cachedPayload.tree_version}:${
      cachedPayload.page?.content_hash ?? cachedPayload.folder?.id ?? ""
    }`;
    const freshKey = `${fresh.tree_version}:${
      fresh.page?.content_hash ?? fresh.folder?.id ?? ""
    }`;
    if (cachedKey === freshKey) return;
    if (fresh.kind === "page" && fresh.page?.source_type === "html") {
      window.location.assign(url.pathname + url.search + url.hash);
      return;
    }
    swapDocument(fresh);
    if (state) {
      state.currentPayload = fresh;
    }
    document.title = fresh.header.title;
    document.dispatchEvent(new CustomEvent("astro:page-load"));
  } catch (error) {
    console.warn("[vpg-shell] popstate revalidation failed:", error);
  }
}

// Exported for tests; see scripts/shell/__tests__/index.test.ts. The
// helpers are pure so they can run under Node's test environment.
export function shouldHandle(url: URL): boolean {
  return SHELL_PATH_RE.test(url.pathname);
}

export function payloadUrlFor(workspaceId: string, url: URL): string | null {
  // The partial endpoint shares the API access helpers, which require
  // workspace_id in the query string. We carry it explicitly even though
  // the path also contains it — the helpers compare both.
  const ws = encodeURIComponent(workspaceId);
  const pageMatch = url.pathname.match(PAGE_PAYLOAD_RE);
  if (pageMatch) {
    return `/api/workspaces/${ws}/documents/page/${encodeURIComponent(pageMatch[1])}?workspace_id=${ws}`;
  }
  const folderMatch = url.pathname.match(FOLDER_PAYLOAD_RE);
  if (folderMatch) {
    return `/api/workspaces/${ws}/documents/folder/${encodeURIComponent(folderMatch[1])}?workspace_id=${ws}`;
  }
  return null;
}

async function fetchPayload(
  workspaceId: string,
  url: URL,
  bookmark: string | null,
): Promise<DocumentPayload | null> {
  const endpoint = payloadUrlFor(workspaceId, url);
  if (!endpoint) return null;
  const headers: HeadersInit = { accept: "application/json" };
  if (bookmark)
    (headers as Record<string, string>)["x-vpg-d1-bookmark"] = bookmark;
  const response = await fetch(endpoint, {
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  const nextBookmark = response.headers.get("x-vpg-d1-bookmark");
  if (nextBookmark && state) {
    state.d1Bookmark = nextBookmark;
    writeBookmark(nextBookmark);
  }
  const payload = (await response.json()) as DocumentPayload;
  return payload;
}

function swapDocument(payload: DocumentPayload): void {
  // 1. Tear down per-page controllers BEFORE the DOM swap so they can
  //    inspect their old DOM to detach listeners cleanly.
  try {
    window.__vpgPageEditorControllerCleanup?.();
    window.__vpgPageEditorControllerCleanup = undefined;
  } catch (error) {
    console.warn("[vpg-shell] editor cleanup failed:", error);
  }

  // 2. Update the persistent <article> element's data-* attributes to
  //    reflect the new page. The article wraps the swap zone and outlives
  //    the swap; without this update, page-editor-controller and other
  //    listeners would bind to stale page metadata.
  const article = document.querySelector<HTMLElement>(".vpg-shell-article");
  if (article) {
    if (payload.kind === "page" && payload.page) {
      article.dataset.pageId = payload.page.id;
      article.dataset.pageTitle = payload.page.title;
      article.dataset.sourceType = payload.page.source_type;
      article.dataset.workspaceId = payload.workspace.id;
      if (payload.permissions.canEdit) {
        article.dataset.vpgPageEditor = "true";
      } else {
        delete article.dataset.vpgPageEditor;
      }
    } else if (payload.kind === "folder" && payload.folder) {
      article.dataset.workspaceId = payload.workspace.id;
      delete article.dataset.pageId;
      delete article.dataset.pageTitle;
      delete article.dataset.sourceType;
      delete article.dataset.vpgPageEditor;
    }
    // Reset the editor-initialized guard so the page-editor-controller
    // re-runs against the new page on the upcoming astro:page-load.
    delete article.dataset.editorInitialized;
  }

  // 3. Swap document content.
  const main = document.getElementById("vpg-document");
  if (main) main.innerHTML = payload.document_html;

  // 4. Update auxiliary zones (header chips, breadcrumb) when present.
  //    These DOM slots are populated by SSR today and may not yet exist
  //    in every layout variant — null-guarded.
  const breadcrumb = document.getElementById("vpg-breadcrumb");
  if (breadcrumb) breadcrumb.innerHTML = renderBreadcrumb(payload);
  const meta = document.getElementById("vpg-header-meta");
  if (meta) meta.innerHTML = payload.header.meta_html;

  // 5. Expose current page identifiers on <html> for any global scripts
  //    that want to read them without re-querying the article element.
  document.documentElement.dataset.vpgPageId =
    payload.page?.id ?? payload.folder?.id ?? "";
  document.documentElement.dataset.vpgContentHash =
    payload.page?.content_hash ?? "";
}

function renderBreadcrumb(payload: DocumentPayload): string {
  return payload.breadcrumb.items
    .map((item, index) => {
      const isLast = index === payload.breadcrumb.items.length - 1;
      const anchor = isLast
        ? `<span class="vpg-breadcrumb__current">${escapeHtml(item.label)}</span>`
        : `<a href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>`;
      const separator = isLast
        ? ""
        : `<span class="vpg-breadcrumb__sep" aria-hidden="true">/</span>`;
      return `<li class="vpg-breadcrumb__item" data-kind="${escapeAttr(item.kind)}">${anchor}${separator}</li>`;
    })
    .join("");
}

const BOOKMARK_STORAGE_KEY = "vpg.d1.bookmark";

function readBookmark(): string | null {
  try {
    return window.sessionStorage.getItem(BOOKMARK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeBookmark(value: string): void {
  try {
    window.sessionStorage.setItem(BOOKMARK_STORAGE_KEY, value);
  } catch {
    // sessionStorage disabled (private mode etc) — silently no-op.
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
