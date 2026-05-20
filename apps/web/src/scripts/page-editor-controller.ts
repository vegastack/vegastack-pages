import type { PageEditorApi, PageEditorInit } from "./page-editor-codemirror";
import { enhanceProse } from "./prose-enhancements";
import { renderTocRail, type TocHeading } from "./toc-rail";

type SourcePayload = {
  page_id?: string;
  source_type?: "markdown" | "mdx" | "html";
  source?: string;
  version_id?: string;
};

type RenderedPayload = {
  html?: string;
  source_type?: "markdown" | "mdx" | "html";
  headings?: TocHeading[];
  frontmatter?: Record<string, unknown>;
};

type EditorModule = typeof import("./page-editor-codemirror");

type ControllerState = {
  api: PageEditorApi | null;
  editable: boolean;
  loading: boolean;
  modulePromise: Promise<EditorModule> | null;
  readyPromise: Promise<{ mod: EditorModule; payload: SourcePayload }> | null;
};

export function initPageEditorController() {
  const root = document.querySelector<HTMLElement>("[data-vpg-page-editor]");
  if (!root || root.dataset.editorInitialized === "true") return;
  window.__vpgPageEditorControllerCleanup?.();
  window.__vpgPageEditorControllerCleanup = undefined;
  root.dataset.editorInitialized = "true";

  const pageId = root.dataset.pageId;
  const sourceType = root.dataset.sourceType;
  const title = root.dataset.pageTitle ?? "";
  const host = root.querySelector<HTMLElement>("[data-vpg-editor-host]");
  if (!pageId || !host) return;
  if (
    sourceType !== "markdown" &&
    sourceType !== "mdx" &&
    sourceType !== "html"
  ) {
    return;
  }
  const rootEl = root;
  const hostEl = host;
  const pageIdValue = pageId;
  const sourceTypeValue = sourceType;

  const state: ControllerState = {
    api: null,
    editable: false,
    loading: false,
    modulePromise: null,
    readyPromise: null,
  };
  const guestNameRequired = root.dataset.guestNameRequired === "true";

  function loadModule() {
    state.modulePromise ??= import("./page-editor-codemirror");
    return state.modulePromise;
  }

  function preload() {
    if (state.readyPromise) return state.readyPromise;
    state.readyPromise = Promise.all([
      loadModule(),
      fetchSource(pageIdValue),
    ]).then(([mod, payload]) => ({ mod, payload }));
    state.readyPromise.catch(() => {
      state.modulePromise = null;
      state.readyPromise = null;
      setSaveStatus("error");
      setMessage(rootEl, "Editor failed to load.");
    });
    return state.readyPromise;
  }

  async function ensureEditor() {
    if (state.api) return state.api;
    const { mod, payload } = await preload();
    const source = payload.source ?? "";
    const versionId = payload.version_id ?? "";
    const init: PageEditorInit = {
      pageId: pageIdValue,
      source,
      sourceType: sourceTypeValue,
      title,
      versionId,
      guestNameRequired,
      mount: hostEl,
      onReady: () => hideStaticSurface(rootEl),
    };
    state.api = mod.createPageEditor(init);
    window.__vpgCurrentSource = state.api.getSource();
    window.dispatchEvent(
      new CustomEvent("vpg:source-change", {
        detail: { source: state.api.getSource(), sourceType: sourceTypeValue },
      }),
    );
    return state.api;
  }

  async function setEditable(editable: boolean) {
    if (state.loading) return;
    state.loading = true;
    setEditButtonLoading(true);
    setMessage(rootEl, "");
    try {
      const editor = await ensureEditor();
      if (editable) {
        showEditorSurface(rootEl, hostEl);
      } else {
        await editor.flushSave(false);
        await refreshStaticSurface(
          rootEl,
          hostEl,
          pageIdValue,
          sourceTypeValue,
        );
      }
      editor.setEditable(editable);
      state.editable = editable;
      window.dispatchEvent(
        new CustomEvent("vpg:edit-state", { detail: { editable } }),
      );
      if (editable) editor.focus();
    } catch {
      setSaveStatus("error");
      setMessage(rootEl, "Editor failed to load.");
    } finally {
      state.loading = false;
      setEditButtonLoading(false);
    }
  }

  function toggle() {
    window.__vpgEditIntent = false;
    void setEditable(!state.editable);
  }

  function onIntent(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest("[data-vpg-toggle-edit]")) return;
    void preload();
  }

  window.addEventListener("vpg:toggle-edit", toggle);
  document.addEventListener("pointerenter", onIntent, true);
  document.addEventListener("focusin", onIntent, true);
  window.__vpgPageEditorControllerCleanup = () => {
    window.removeEventListener("vpg:toggle-edit", toggle);
    document.removeEventListener("pointerenter", onIntent, true);
    document.removeEventListener("focusin", onIntent, true);
    window.__vpgPageEditorControllerCleanup = undefined;
  };
  scheduleIdlePreload(preload);
  if (window.__vpgEditIntent) toggle();
}

async function fetchSource(pageId: string): Promise<SourcePayload> {
  const response = await fetch(withPageQuery(`/api/pages/${pageId}/source`));
  if (!response.ok) throw new Error("SOURCE_LOAD_FAILED");
  return (await response.json()) as SourcePayload;
}

async function fetchRendered(pageId: string): Promise<RenderedPayload> {
  const response = await fetch(withPageQuery(`/api/pages/${pageId}/rendered`));
  if (!response.ok) throw new Error("RENDERED_LOAD_FAILED");
  return (await response.json()) as RenderedPayload;
}

function withPageQuery(path: string) {
  const url = new URL(path, window.location.origin);
  const current = new URLSearchParams(window.location.search);
  const workspaceId =
    current.get("workspace_id") ??
    document.querySelector<HTMLElement>("[data-vpg-page-editor]")?.dataset
      .workspaceId ??
    document.querySelector<HTMLElement>("[data-vpg-workspace-id]")?.dataset
      .vpgWorkspaceId;
  if (workspaceId) url.searchParams.set("workspace_id", workspaceId);
  return `${url.pathname}${url.search}`;
}

function hideStaticSurface(root: HTMLElement) {
  const selectors = [
    "[data-vpg-prose-static]",
    "[data-vpg-description-static]",
    "[data-vpg-metadata-static]",
    "[data-vpg-html-static]",
  ];
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    if (element) element.hidden = true;
  }
}

function showStaticSurface(root: HTMLElement, host: HTMLElement) {
  const selectors = [
    "[data-vpg-prose-static]",
    "[data-vpg-description-static]",
    "[data-vpg-metadata-static]",
    "[data-vpg-html-static]",
  ];
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    if (element && element.dataset.vpgEmpty !== "true") element.hidden = false;
  }
  host.hidden = true;
}

function showEditorSurface(root: HTMLElement, host: HTMLElement) {
  hideStaticSurface(root);
  host.hidden = false;
}

async function refreshStaticSurface(
  root: HTMLElement,
  host: HTMLElement,
  pageId: string,
  sourceType: "markdown" | "mdx" | "html",
) {
  if (sourceType === "html") {
    window.location.reload();
    return;
  }

  const payload = await fetchRendered(pageId);
  const title = updateTitle(root, payload.frontmatter);
  const html = displayedHtml(payload, title);
  const prose = root.querySelector<HTMLElement>("[data-vpg-prose-static]");
  if (prose) prose.innerHTML = html;
  updateDescription(root, payload.frontmatter);
  updateMetadata(root, payload.frontmatter);
  renderTocRail(displayedHeadings(payload, title));
  showStaticSurface(root, host);
  enhanceProse();
}

function updateTitle(
  root: HTMLElement,
  _frontmatter: Record<string, unknown> | undefined,
) {
  // The page row's title is the single source of truth. The editor
  // surface keeps whatever the SSR rendered into `.prose-title` and
  // does not let the frontmatter shadow it — older pages with
  // `title:` in YAML used to override here, which is exactly the
  // duplication we just removed.
  const titleEl = root.querySelector<HTMLElement>(".prose-title");
  return titleEl?.textContent?.trim() || "";
}

function updateDescription(
  root: HTMLElement,
  frontmatter: Record<string, unknown> | undefined,
) {
  // `summary` is the new convention (documented in the skill +
  // initialSource); `description` is kept as a legacy fallback for
  // pre-existing pages that wrote that key.
  const description =
    typeof frontmatter?.summary === "string" && frontmatter.summary.trim()
      ? frontmatter.summary
      : typeof frontmatter?.description === "string"
        ? frontmatter.description
        : "";
  let element = root.querySelector<HTMLElement>(
    "[data-vpg-description-static]",
  );
  if (!description.trim()) {
    if (element) {
      element.hidden = true;
      element.dataset.vpgEmpty = "true";
    }
    return;
  }
  if (!element) {
    element = document.createElement("p");
    element.className = "prose-description";
    element.dataset.vpgDescriptionStatic = "true";
    const metadata = root.querySelector("[data-vpg-metadata-static]");
    const prose = root.querySelector("[data-vpg-prose-static]");
    root.insertBefore(element, metadata ?? prose);
  }
  element.textContent = description;
  delete element.dataset.vpgEmpty;
  element.hidden = false;
}

function updateMetadata(
  root: HTMLElement,
  frontmatter: Record<string, unknown> | undefined,
) {
  const entries = Object.entries(frontmatter ?? {}).filter(
    ([key]) => key !== "title" && key !== "description",
  );
  let list = root.querySelector<HTMLElement>("[data-vpg-metadata-static]");
  if (entries.length === 0) {
    if (list) {
      list.hidden = true;
      list.dataset.vpgEmpty = "true";
    }
    return;
  }
  if (!list) {
    list = document.createElement("dl");
    list.className = "metadata-list";
    list.dataset.vpgMetadataStatic = "true";
    list.setAttribute("aria-label", "Page metadata");
    const prose = root.querySelector("[data-vpg-prose-static]");
    root.insertBefore(list, prose);
  }
  list.replaceChildren(
    ...entries.map(([key, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const desc = document.createElement("dd");
      term.textContent = key;
      desc.textContent =
        typeof value === "string" ? value : JSON.stringify(value);
      row.append(term, desc);
      return row;
    }),
  );
  delete list.dataset.vpgEmpty;
  list.hidden = false;
}

function displayedHeadings(payload: RenderedPayload, title: string) {
  const headings = payload.headings ?? [];
  const first = headings[0];
  if (
    first?.depth === 1 &&
    first.text.trim().toLowerCase() === title.trim().toLowerCase()
  ) {
    return headings.slice(1);
  }
  return headings;
}

function displayedHtml(payload: RenderedPayload, title: string) {
  const html = payload.html ?? "";
  const first = payload.headings?.[0];
  if (
    first?.depth === 1 &&
    first.text.trim().toLowerCase() === title.trim().toLowerCase()
  ) {
    return html.replace(/^<h1[^>]*>.*?<\/h1>\s*/s, "");
  }
  return html;
}

function scheduleIdlePreload(preload: () => Promise<unknown>) {
  const idle = window.requestIdleCallback;
  if (idle) {
    idle(() => void preload(), { timeout: 1500 });
    return;
  }
  window.setTimeout(() => void preload(), 500);
}

function setEditButtonLoading(loading: boolean) {
  const buttons = document.querySelectorAll<HTMLElement>(
    "[data-vpg-toggle-edit]",
  );
  for (const button of buttons) {
    button.toggleAttribute("aria-busy", loading);
    const label = button.querySelector<HTMLElement>("[data-edit-label]");
    if (!label) continue;
    if (loading) {
      label.textContent = "Loading";
      continue;
    }
    if (label.textContent === "Loading") {
      label.textContent = button.classList.contains("is-editing")
        ? (button.dataset.editLabelEditing ?? "Done")
        : (button.dataset.editLabelReady ?? "Edit");
    }
  }
}

function setSaveStatus(status: "idle" | "saved" | "saving" | "error") {
  window.dispatchEvent(
    new CustomEvent("vpg:save-status", { detail: { status } }),
  );
}

function setMessage(root: HTMLElement, message: string) {
  const slot = root.querySelector<HTMLElement>("[data-vpg-editor-message]");
  if (slot) slot.textContent = message;
}

declare global {
  interface Window {
    __vpgEditIntent?: boolean;
    __vpgCurrentSource?: string;
    __vpgPageEditorControllerCleanup?: () => void;
  }
}
