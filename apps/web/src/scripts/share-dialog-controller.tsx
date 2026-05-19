import type { Root } from "react-dom/client";

type ShareTrigger = HTMLButtonElement & {
  dataset: {
    workspaceId?: string;
    resourceId?: string;
    resourceSlugId?: string;
    resourceType?: "page" | "folder";
  };
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let activeTrigger: ShareTrigger | null = null;
let loading = false;

export function initShareDialogController() {
  if (window.__vpgShareDialogInitialized) return;
  window.__vpgShareDialogInitialized = true;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest<ShareTrigger>("[data-vpg-share-trigger]");
    if (!trigger) return;
    void openShareDialog(trigger);
  });
}

async function openShareDialog(trigger: ShareTrigger) {
  if (loading) return;
  loading = true;
  activeTrigger = trigger;
  trigger.setAttribute("aria-busy", "true");
  try {
    const [{ createElement }, { createRoot }, { ShareDialog }] =
      await Promise.all([
        import("react"),
        import("react-dom/client"),
        import("../components/ShareDialog"),
      ]);
    if (!host) {
      host = document.createElement("div");
      host.dataset.vpgShareDialogHost = "true";
      document.body.append(host);
      root = createRoot(host);
    }
    const props = {
      workspaceId: trigger.dataset.workspaceId ?? "",
      resourceId: trigger.dataset.resourceId ?? "",
      resourceSlugId: trigger.dataset.resourceSlugId ?? "",
      resourceType:
        trigger.dataset.resourceType === "folder"
          ? ("folder" as const)
          : ("page" as const),
      open: true,
      onOpenChange: (open: boolean) => {
        if (!open) renderClosed();
      },
    };
    root?.render(createElement(ShareDialog, props));
  } catch (error) {
    // Mirrors the sidebar-create-controller diagnostic shape so the
    // browser console always reports the underlying reason — Vite
    // optimize-dep 504s, missing exports, etc. — instead of just the
    // user-facing toast.
    console.error("[vpg-share-dialog] mount failed:", error);
    const detail = error instanceof Error && error.message ? error.message : "";
    window.vpgToast?.error(
      "Share controls failed to load." + (detail ? `\n${detail}` : ""),
    );
  } finally {
    trigger.removeAttribute("aria-busy");
    loading = false;
  }
}

async function renderClosed() {
  if (!root || !activeTrigger) return;
  const [{ createElement }, { ShareDialog }] = await Promise.all([
    import("react"),
    import("../components/ShareDialog"),
  ]);
  const trigger = activeTrigger;
  root.render(
    createElement(ShareDialog, {
      workspaceId: trigger.dataset.workspaceId ?? "",
      resourceId: trigger.dataset.resourceId ?? "",
      resourceSlugId: trigger.dataset.resourceSlugId ?? "",
      resourceType:
        trigger.dataset.resourceType === "folder" ? "folder" : "page",
      open: false,
      onOpenChange: () => null,
    }),
  );
}

declare global {
  interface Window {
    __vpgShareDialogInitialized?: boolean;
  }
}
