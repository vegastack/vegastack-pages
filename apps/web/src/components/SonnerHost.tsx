import { useEffect } from "react";
import { Toaster, toast } from "sonner";
import {
  clearPendingTrashUndoToast,
  readPendingTrashUndoToast,
  remainingHandoffDuration,
} from "../lib/trash-toast-handoff";

declare global {
  interface Window {
    vpgToast: typeof toast;
  }
}

if (typeof window !== "undefined") {
  // Expose the sonner toast() function globally so Astro inline scripts can call
  // window.vpgToast.success(...) without each script having to import sonner.
  window.vpgToast = toast;
}

async function undoRestore(
  pageId: string,
  workspaceId: string,
  slugId: string,
  title: string,
) {
  try {
    const response = await window.fetch(
      `/api/pages/${pageId}/restore?workspace_id=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (!response.ok) throw new Error("Could not restore the page.");
    toast.success(`Restored "${title}"`);
    window.location.assign(`/p/${slugId}`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Restore failed.");
  }
}

function replayPendingTrashUndo() {
  const handoff = readPendingTrashUndoToast();
  if (!handoff) return;
  clearPendingTrashUndoToast();
  const duration = remainingHandoffDuration(handoff);
  if (duration <= 0) return;
  toast(`Moved "${handoff.title}" to trash`, {
    duration,
    action: {
      label: "Undo",
      onClick: () =>
        void undoRestore(
          handoff.pageId,
          handoff.workspaceId,
          handoff.slugId,
          handoff.title,
        ),
    },
  });
}

export function SonnerHost() {
  useEffect(() => {
    window.vpgToast = toast;
    // Replay any cross-page undo toast queued by the previous
    // page (e.g. the user trashed the page they were viewing,
    // we hard-navigated here, and the toast needs to surface
    // here with its remaining time). Runs once per mount + on
    // each Astro ClientRouter swap.
    replayPendingTrashUndo();
    const onPageLoad = () => replayPendingTrashUndo();
    document.addEventListener("astro:page-load", onPageLoad);
    return () => document.removeEventListener("astro:page-load", onPageLoad);
  }, []);

  return (
    <Toaster
      position="bottom-right"
      theme="system"
      closeButton
      richColors={false}
      offset={16}
      toastOptions={{
        className: "vpg-sonner-toast",
        duration: 3200,
      }}
    />
  );
}
