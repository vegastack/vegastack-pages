// Cross-page handoff for the "Moved to trash" undo toast.
//
// Soft-deleting the page you're currently viewing forces a hard
// navigation (the URL would otherwise show a now-trashed document).
// A toast fired right before `window.location.assign` is destroyed
// by the navigation — the sonner host on the destination page is a
// fresh React instance.
//
// To keep the 10-second undo window honest, the trashing site writes
// the intent into sessionStorage with a short expiry. The destination
// page's SonnerHost reads it on mount, re-fires the toast (which now
// runs its own 10s timer against the destination's clock), then
// clears the key.

const STORAGE_KEY = "vpg:trash-undo-toast";
const HANDOFF_TTL_MS = 10_000;

export interface TrashUndoHandoff {
  pageId: string;
  workspaceId: string;
  slugId: string;
  title: string;
  /** Absolute ms timestamp when the toast handoff was queued. */
  queuedAt: number;
}

export function queueTrashUndoToast(
  handoff: Omit<TrashUndoHandoff, "queuedAt">,
) {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...handoff, queuedAt: Date.now() }),
    );
  } catch {
    // sessionStorage can be unavailable (private mode quirks). The
    // toast just won't survive the navigation — non-fatal.
  }
}

export function readPendingTrashUndoToast(): TrashUndoHandoff | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TrashUndoHandoff;
    if (
      !parsed ||
      typeof parsed.pageId !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.slugId !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.queuedAt !== "number"
    ) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // If we're past the TTL the user has effectively missed the undo
    // window. Drop the key so a future page-load doesn't get an
    // orphan toast.
    if (Date.now() - parsed.queuedAt > HANDOFF_TTL_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingTrashUndoToast() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// Remaining ms a queued toast still has before the 10s TTL hits.
// Caller passes the value into sonner's `duration` so the toast
// only stays visible for the time the user hasn't already burned.
export function remainingHandoffDuration(handoff: TrashUndoHandoff): number {
  return Math.max(0, HANDOFF_TTL_MS - (Date.now() - handoff.queuedAt));
}
