declare global {
  interface Window {
    __vpgSidebarCreateInitialized?: boolean;
  }
}

let mounted = false;
let mounting: Promise<void> | null = null;

function findWorkspaceId(trigger: HTMLElement) {
  const sidebar = trigger.closest("[data-workspace-id]");
  if (sidebar instanceof HTMLElement && sidebar.dataset.workspaceId) {
    return sidebar.dataset.workspaceId;
  }
  const currentSidebar = document.getElementById("vpg-sidebar");
  return currentSidebar?.dataset.workspaceId || "";
}

function hasLiveHost(workspaceId: string) {
  return Boolean(
    document.querySelector(
      `[data-vpg-sidebar-create-host][data-workspace-id="${CSS.escape(workspaceId)}"]`,
    ),
  );
}

async function mountCreateMenu(workspaceId: string) {
  if (mounted && hasLiveHost(workspaceId)) return;
  if (mounting) return mounting;

  mounting = (async () => {
    const host = document.createElement("div");
    host.dataset.vpgSidebarCreateHost = "true";
    host.dataset.workspaceId = workspaceId;
    document.body.append(host);

    const [{ createElement }, { createRoot }, { SidebarCreateMenu }] =
      await Promise.all([
        import("react"),
        import("react-dom/client"),
        import("../components/SidebarCreateMenu"),
      ]);

    createRoot(host).render(createElement(SidebarCreateMenu, { workspaceId }));
    mounted = true;
    mounting = null;
  })().catch((error) => {
    mounted = false;
    mounting = null;
    throw error;
  });

  return mounting;
}

export function initSidebarCreateController() {
  if (window.__vpgSidebarCreateInitialized) return;
  window.__vpgSidebarCreateInitialized = true;

  window.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const trigger = target.closest("[data-vpg-create-trigger]");
      if (!(trigger instanceof HTMLElement)) return;
      const workspaceId = findWorkspaceId(trigger);
      if (!workspaceId) return;
      if (mounted && hasLiveHost(workspaceId)) return;

      event.preventDefault();
      event.stopPropagation();

      void mountCreateMenu(workspaceId)
        .then(() => {
          window.requestAnimationFrame(() => {
            trigger.dispatchEvent(
              new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                view: window,
              }),
            );
          });
        })
        .catch((error: unknown) => {
          // Log the real cause to the browser console (and let DevTools
          // preserve the stack trace) before surfacing the user-facing
          // toast. Without the console line, sidebar mount failures
          // are completely opaque to operators.
          console.error("[vpg-sidebar-create] mount failed:", error);
          const detail =
            error instanceof Error && error.message ? error.message : "";
          // Sonner toast via the global helper installed in
          // SonnerHost — same surface every other controller uses, so
          // styling and dismissal stay consistent. Native `alert` is
          // blocking and out of place in the Sonner-toast UX.
          window.vpgToast?.error(
            "Create controls could not be loaded. Refresh and try again." +
              (detail ? `\n${detail}` : ""),
          );
        });
    },
    true,
  );
}
