import {
  dispatchPageFavoriteChange,
  persistPageFavorite,
} from "../lib/page-favorites";

export function initPageHeaderControls() {
  if (window.__vpgPageHeaderControlsInitialized) return;
  window.__vpgPageHeaderControlsInitialized = true;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const favorite = target.closest<HTMLButtonElement>(
      "[data-vpg-favorite-toggle]",
    );
    if (favorite) {
      event.preventDefault();
      void toggleFavorite(favorite);
      return;
    }
    const search = target.closest("[data-vpg-sidebar-search]");
    if (search) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("vpg:open-search"));
      return;
    }
    const edit = target.closest<HTMLButtonElement>(
      "button[data-vpg-toggle-edit]",
    );
    if (edit) {
      event.preventDefault();
      window.__vpgEditIntent = true;
      window.dispatchEvent(new CustomEvent("vpg:toggle-edit", { detail: {} }));
    }
  });

  window.addEventListener("vpg:favorites-changed", (event) => {
    const detail = (
      event as CustomEvent<{
        workspaceId?: string;
        pageId?: string;
        favorited?: boolean;
      }>
    ).detail;
    if (!detail?.workspaceId || !detail.pageId) return;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-vpg-favorite-toggle]",
    )) {
      if (
        button.dataset.workspaceId !== detail.workspaceId ||
        button.dataset.pageId !== detail.pageId
      ) {
        continue;
      }
      setFavoriteButtonState(button, Boolean(detail.favorited), false);
    }
  });

  window.addEventListener("vpg:edit-state", (event) => {
    const editable = Boolean(
      (event as CustomEvent<{ editable?: boolean }>).detail?.editable,
    );
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-vpg-toggle-edit]",
    )) {
      button.classList.toggle("is-editing", editable);
      button.setAttribute("aria-pressed", String(editable));
      button.setAttribute(
        "aria-label",
        editable ? "Done editing" : "Edit page",
      );
      button.title = editable ? "Done editing" : "Edit page";
      const label = button.querySelector<HTMLElement>("[data-edit-label]");
      if (label) {
        label.textContent = editable
          ? (button.dataset.editLabelEditing ?? "Done")
          : (button.dataset.editLabelReady ?? "Edit");
      }
    }
  });

  updateSearchShortcut();
}

async function toggleFavorite(button: HTMLButtonElement) {
  if (button.disabled) return;
  const workspaceId = button.dataset.workspaceId ?? "";
  const pageId = button.dataset.pageId ?? "";
  const next = button.dataset.pinned !== "true";
  setFavoriteButtonState(button, next, true);
  dispatchPageFavoriteChange({
    workspaceId,
    pageId,
    slugId: button.dataset.slugId,
    title: button.dataset.title,
    favorited: next,
  });
  try {
    await persistPageFavorite(workspaceId, pageId, next);
  } catch {
    setFavoriteButtonState(button, !next, false);
    dispatchPageFavoriteChange({
      workspaceId,
      pageId,
      slugId: button.dataset.slugId,
      title: button.dataset.title,
      favorited: !next,
    });
  } finally {
    button.disabled = false;
  }
}

function setFavoriteButtonState(
  button: HTMLButtonElement,
  pinned: boolean,
  pending: boolean,
) {
  button.dataset.pinned = String(pinned);
  button.setAttribute("aria-pressed", String(pinned));
  button.disabled = pending;
  button.setAttribute(
    "aria-label",
    pinned ? "Remove from favorites" : "Add to favorites",
  );
  button.title = pinned ? "Pinned to sidebar" : "Pin to sidebar";
}

function updateSearchShortcut() {
  const platform = (
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.userAgent
  ).toLowerCase();
  const isMac = /mac|iphone|ipad|ipod/.test(platform);
  for (const kbd of document.querySelectorAll<HTMLElement>(
    ".vpg-sidebar-search-kbd",
  )) {
    kbd.innerHTML = isMac
      ? "<span>⌘</span><span>K</span>"
      : "<span>Ctrl</span><span>K</span>";
  }
}

declare global {
  interface Window {
    __vpgPageHeaderControlsInitialized?: boolean;
  }
}
