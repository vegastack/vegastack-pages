// Kebab menu for a single page row. Mounts in:
//   - SidebarTreeNode.astro / Sidebar.astro (hover the row, click the
//     dots to open). One instance per page row.
//   - PageHeader.astro (top-right of the page being viewed). Single
//     instance, opened from the header.
//
// Actions are intentionally a small set in v1:
//   - Copy link (clipboard the public /p/ URL)
//   - Move to… (opens the MoveToFolderDialog — folder picker)
//   - Move to trash (soft-delete with undo toast)
//
// Undo: soft-delete returns success immediately AND we register an
// undo callback on the sonner toast. Clicking Undo calls
// POST /api/pages/:id/restore. The 10s sonner duration matches Linear
// and Notion. If the page being viewed is the one trashed, we bounce
// to /app so the user doesn't sit on a now-soft-deleted document.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MoveToFolderDialog } from "./MoveToFolderDialog";

interface FolderOption {
  id: string;
  path: string;
  name: string;
}

export interface PageRowMenuProps {
  pageId: string;
  workspaceId: string;
  slugId: string;
  title: string;
  /** Folders the user can move into. Pre-flattened by the caller. */
  folders: FolderOption[];
  /** Used to pivot back when the current page is trashed. */
  workspaceHref?: string;
  /** Visual variant. "sidebar" hugs the right side of the row;
      "header" sits inline among the page-header action buttons. */
  surface?: "sidebar" | "header";
}

export function PageRowMenu({
  pageId,
  workspaceId,
  slugId,
  title,
  folders,
  workspaceHref,
  surface = "sidebar",
}: PageRowMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onAway(event: MouseEvent) {
      const wrapper = wrapperRef.current;
      if (wrapper && !wrapper.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onAway);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  async function softDelete() {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/pages/${pageId}/trash?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          payload?.error?.message ?? "Could not move the page to trash.",
        );
      }
      // Hide the sidebar row immediately for snappy feedback. A real
      // navigation will resync from the server.
      const row =
        surface === "sidebar"
          ? (document.querySelector(
              `[data-page-row-id="${pageId}"]`,
            ) as HTMLElement | null)
          : null;
      if (row) row.style.display = "none";

      toast(`Moved "${title}" to trash`, {
        duration: 10_000,
        action: {
          label: "Undo",
          onClick: () => {
            void restorePage(pageId, workspaceId, () => {
              if (row) row.style.display = "";
            });
          },
        },
      });
      if (
        typeof window !== "undefined" &&
        window.location.pathname === `/p/${slugId}`
      ) {
        window.location.assign(workspaceHref ?? "/app");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not move the page.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    setOpen(false);
    const url = `${window.location.origin}/p/${slugId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy link");
    }
  }

  return (
    <>
      <div
        ref={wrapperRef}
        className={`vpg-row-menu vpg-row-menu-${surface}`}
        data-open={open ? "true" : undefined}
      >
        <button
          type="button"
          className="vpg-row-menu-trigger"
          aria-label={`Actions for ${title}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            width={14}
            height={14}
          >
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </button>
        {open && (
          <div role="menu" className="vpg-row-menu-popover">
            <button
              type="button"
              role="menuitem"
              className="vpg-row-menu-item"
              onClick={() => {
                setOpen(false);
                setMoveOpen(true);
              }}
            >
              Move to…
            </button>
            <button
              type="button"
              role="menuitem"
              className="vpg-row-menu-item"
              onClick={copyLink}
            >
              Copy link
            </button>
            <div className="vpg-row-menu-separator" />
            <button
              type="button"
              role="menuitem"
              className="vpg-row-menu-item vpg-row-menu-danger"
              onClick={softDelete}
              disabled={busy}
            >
              Move to trash
            </button>
          </div>
        )}
      </div>
      {moveOpen && (
        <MoveToFolderDialog
          pageId={pageId}
          workspaceId={workspaceId}
          title={title}
          folders={folders}
          onClose={(moved) => {
            setMoveOpen(false);
            if (moved) {
              // Trigger a full reload so the sidebar tree resyncs at
              // the new location.
              window.location.reload();
            }
          }}
        />
      )}
    </>
  );
}

async function restorePage(
  pageId: string,
  workspaceId: string,
  onSuccess: () => void,
) {
  try {
    const response = await fetch(
      `/api/pages/${pageId}/restore?workspace_id=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (!response.ok) {
      throw new Error("Could not restore the page.");
    }
    onSuccess();
    toast.success("Page restored");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Restore failed.");
  }
}
