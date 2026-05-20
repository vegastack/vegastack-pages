// Inline edit for the page title (the `.prose-title` <h1> on /p/{slug}).
//
// Behavior — Notion / Google Docs style:
//   - Click anywhere in the title to start editing (contenteditable
//     was already applied server-side so users see the affordance
//     without JS).
//   - Enter commits, Escape cancels, blur commits.
//   - On Enter / blur with a changed value, fire
//     POST /api/pages/:id/move with the new title. The route already
//     updates `pages.title`, regenerates `slug` + `slug_id` for the
//     new title, and returns the new slug_id so we can rewrite the
//     URL without a full reload.
//   - Optimistic: the H1 keeps the new text immediately; on server
//     error the original text is restored and a toast appears.
//   - Multi-line paste is collapsed to a single line.
//   - Whitespace-only commits are rejected (title must be non-empty);
//     we revert to the previous value silently.
//
// Wired up via `astro:page-load` so it survives view-transitions.

const ATTACHED = Symbol("vpg-title-attached");

interface TitleHostMeta {
  pageId: string;
  workspaceId: string;
  slugId: string;
}

function getMeta(element: HTMLElement): TitleHostMeta | null {
  const pageId = element.dataset.pageId;
  const workspaceId = element.dataset.workspaceId;
  const slugId = element.dataset.slugId;
  if (!pageId || !workspaceId || !slugId) return null;
  return { pageId, workspaceId, slugId };
}

function sanitizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function commitTitle(
  element: HTMLElement,
  meta: TitleHostMeta,
  original: string,
  next: string,
): Promise<void> {
  if (next === original) return;
  if (next.length === 0) {
    element.textContent = original;
    return;
  }
  // Optimistic: leave the new text in place.
  element.textContent = next;
  document.title = `${next} · VegaStack Pages`;
  try {
    const response = await window.fetch(
      `/api/pages/${meta.pageId}/move?workspace_id=${encodeURIComponent(meta.workspaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: next }),
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(payload?.error?.message ?? "Could not save the title.");
    }
    const data = (await response.json().catch(() => null)) as {
      page?: { slugId?: string };
      url?: string;
    } | null;
    const newSlug = data?.page?.slugId ?? meta.slugId;
    if (newSlug && newSlug !== meta.slugId) {
      // Rewrite the URL without reload so deep-links update.
      element.dataset.slugId = newSlug;
      const target = `/p/${newSlug}`;
      if (window.location.pathname !== target) {
        window.history.replaceState(null, "", target);
      }
    }
    // Fire a generic event so any other surfaces (breadcrumb,
    // sidebar) can resync if they want to.
    window.dispatchEvent(
      new CustomEvent("vpg:page-title-changed", {
        detail: { pageId: meta.pageId, title: next, slugId: newSlug },
      }),
    );
  } catch (error) {
    element.textContent = original;
    document.title = `${original} · VegaStack Pages`;
    // Best-effort surface; SonnerHost.tsx populates `window.vpgToast`
    // when the toast island is mounted. We cast through unknown so
    // we don't fight the global type SonnerHost declares.
    const toaster = (
      window as unknown as {
        vpgToast?: { error?: (message: string) => void };
      }
    ).vpgToast;
    if (toaster && typeof toaster.error === "function") {
      toaster.error(
        error instanceof Error ? error.message : "Could not save the title.",
      );
    } else {
      console.error("[vpg.title-edit]", error);
    }
  }
}

function attach(element: HTMLElement) {
  // Avoid double-binding when the script reruns under ClientRouter.
  if ((element as unknown as { [k: symbol]: boolean })[ATTACHED]) return;
  (element as unknown as { [k: symbol]: boolean })[ATTACHED] = true;

  if (element.contentEditable !== "plaintext-only") return;
  const meta = getMeta(element);
  if (!meta) return;

  let baseline = element.textContent?.trim() ?? "";

  element.addEventListener("focus", () => {
    baseline = element.textContent?.trim() ?? "";
  });

  element.addEventListener("paste", (event) => {
    // Plaintext paste; collapse newlines.
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const collapsed = sanitizeTitle(text);
    document.execCommand("insertText", false, collapsed);
  });

  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      element.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      element.textContent = baseline;
      element.blur();
    }
  });

  element.addEventListener("blur", () => {
    const next = sanitizeTitle(element.textContent ?? "");
    if (next === baseline) return;
    void commitTitle(element, meta, baseline, next);
    baseline = next.length > 0 ? next : baseline;
  });
}

function scan() {
  document
    .querySelectorAll<HTMLElement>("[data-vpg-page-title]")
    .forEach(attach);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scan);
} else {
  scan();
}
document.addEventListener("astro:page-load", scan);

export {};
