import type { Root } from "react-dom/client";

type ActionsTrigger = HTMLButtonElement & {
  dataset: {
    workspaceId?: string;
    pageId?: string;
    slugId?: string;
    title?: string;
    sourceType?: "markdown" | "mdx" | "html";
    canEdit?: string;
    canComment?: string;
    canFavorite?: string;
    initialFavorited?: string;
    canRestoreVersions?: string;
    canExportSource?: string;
    workspaceHref?: string;
    folderOptions?: string;
  };
};

const roots = new WeakMap<HTMLElement, Root>();
let loading = false;

export function initPageActionsController() {
  if (window.__vpgPageActionsInitialized) return;
  window.__vpgPageActionsInitialized = true;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest<ActionsTrigger>(
      "[data-vpg-page-actions-trigger]",
    );
    if (!trigger) return;
    event.preventDefault();
    void mountActions(trigger);
  });
}

async function mountActions(trigger: ActionsTrigger) {
  if (loading) return;
  loading = true;
  trigger.setAttribute("aria-busy", "true");
  try {
    const [{ createElement }, { createRoot }, { PageActionsMenu }] =
      await Promise.all([
        import("react"),
        import("react-dom/client"),
        import("../components/PageActionsMenu"),
      ]);
    const host = ensureHost(trigger);
    const root = roots.get(host) ?? createRoot(host);
    roots.set(host, root);
    trigger.hidden = true;
    root.render(
      createElement(PageActionsMenu, {
        workspaceId: trigger.dataset.workspaceId ?? "",
        pageId: trigger.dataset.pageId ?? "",
        slugId: trigger.dataset.slugId ?? "",
        title: trigger.dataset.title ?? "Page",
        sourceType:
          trigger.dataset.sourceType === "mdx" ||
          trigger.dataset.sourceType === "html"
            ? trigger.dataset.sourceType
            : "markdown",
        canEdit: trigger.dataset.canEdit === "true",
        canComment: trigger.dataset.canComment === "true",
        canFavorite: trigger.dataset.canFavorite !== "false",
        initialFavorited: trigger.dataset.initialFavorited === "true",
        canRestoreVersions: trigger.dataset.canRestoreVersions === "true",
        canExportSource: trigger.dataset.canExportSource === "true",
        autoOpen: true,
        workspaceHref: trigger.dataset.workspaceHref ?? "/app",
        folders: parseFolderOptions(trigger.dataset.folderOptions),
      }),
    );
  } catch (error) {
    // Mirrors sidebar-create-controller + share-dialog-controller —
    // log the underlying cause to the console so Vite optimize-dep
    // 504s and other dynamic-import failures aren't opaque behind
    // the generic toast.
    console.error("[vpg-page-actions] mount failed:", error);
    const detail = error instanceof Error && error.message ? error.message : "";
    trigger.hidden = false;
    window.vpgToast?.error(
      "Page actions failed to load." + (detail ? `\n${detail}` : ""),
    );
  } finally {
    trigger.removeAttribute("aria-busy");
    loading = false;
  }
}

function parseFolderOptions(
  raw: string | undefined,
): Array<{ id: string; path: string; name: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { id: string; path: string; name: string } =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          typeof entry.path === "string" &&
          typeof entry.name === "string",
        ),
    );
  } catch {
    return [];
  }
}

function ensureHost(trigger: ActionsTrigger) {
  const existing = trigger.nextElementSibling;
  if (
    existing instanceof HTMLElement &&
    existing.dataset.vpgPageActionsHost === "true"
  ) {
    return existing;
  }
  const host = document.createElement("span");
  host.dataset.vpgPageActionsHost = "true";
  trigger.after(host);
  return host;
}

declare global {
  interface Window {
    __vpgPageActionsInitialized?: boolean;
  }
}
