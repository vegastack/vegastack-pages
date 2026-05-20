// Trash list shared between /app/trash (user scope) and
// /app/settings/recovery (workspace scope). Uses Nova primitives —
// Button, Dialog, Input — and the standard Lucide icon set. The
// timestamps render with the workspace + user datetime preferences
// (browser timezone, viewer's locale); see the date pref card on
// Settings → General.

import { FileText, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  formatDateTime,
  type DateTimePreferences,
} from "@vegastack/pages-core";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export interface TrashItem {
  page_id: string;
  title: string;
  folder_path: string;
  slug_id: string;
  deleted_at: string;
  deleted_by?: {
    id: string;
    displayName: string | null;
    email: string;
  } | null;
}

export interface TrashListProps {
  scope: "mine" | "workspace";
  workspaceId: string;
  items: TrashItem[];
  canHardDelete: boolean;
  /** Effective datetime prefs for the viewer (workspace baseline
      merged with the user's override). Passed down from the server
      render. */
  datetimePrefs: DateTimePreferences;
}

export function TrashList({
  scope,
  workspaceId,
  items,
  canHardDelete,
  datetimePrefs,
}: TrashListProps) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [confirmTarget, setConfirmTarget] = useState<TrashItem | null>(null);

  const visibleItems = items.filter((item) => !removed.has(item.page_id));
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  function markBusy(id: string, busy: boolean) {
    setPending((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function restore(item: TrashItem) {
    markBusy(item.page_id, true);
    try {
      const response = await fetch(
        `/api/pages/${item.page_id}/restore?workspace_id=${encodeURIComponent(workspaceId)}`,
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
        throw new Error(payload?.error?.message ?? "Restore failed.");
      }
      toast.success(`Restored "${item.title}"`);
      setRemoved((prev) => new Set([...prev, item.page_id]));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Restore failed.");
    } finally {
      markBusy(item.page_id, false);
    }
  }

  async function hardDelete(item: TrashItem) {
    markBusy(item.page_id, true);
    try {
      const response = await fetch(
        `/api/pages/${item.page_id}/trash?workspace_id=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? "Permanent delete failed.");
      }
      toast.success(`Permanently deleted "${item.title}"`);
      setRemoved((prev) => new Set([...prev, item.page_id]));
      setConfirmTarget(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Permanent delete failed.",
      );
    } finally {
      markBusy(item.page_id, false);
    }
  }

  if (visibleItems.length === 0) {
    return (
      <div className="vpg-trash-empty">
        {scope === "mine"
          ? "No pages in your trash."
          : "No soft-deleted pages in this workspace."}
      </div>
    );
  }

  return (
    <>
      <table className="settings-table vpg-trash-table">
        <thead>
          <tr>
            <th>Page</th>
            {scope === "workspace" && <th>Deleted by</th>}
            <th>Deleted at</th>
            <th className="settings-actions-cell">Actions</th>
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((item) => {
            const busy = pending.has(item.page_id);
            return (
              <tr key={item.page_id}>
                <td>
                  <div className="vpg-trash-title-cell">
                    <FileText
                      size={14}
                      aria-hidden="true"
                      className="vpg-trash-icon"
                    />
                    <div>
                      <div className="vpg-trash-title">{item.title}</div>
                      {item.folder_path && (
                        <div className="vpg-trash-folder">
                          {item.folder_path}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                {scope === "workspace" && (
                  <td>
                    {item.deleted_by
                      ? item.deleted_by.displayName || item.deleted_by.email
                      : "—"}
                  </td>
                )}
                <td>
                  <time dateTime={item.deleted_at}>
                    {formatDateTime(item.deleted_at, {
                      prefs: datetimePrefs,
                      timezone: tz,
                    })}
                  </time>
                </td>
                <td className="settings-actions-cell">
                  <div className="settings-row-actions-group">
                    <Button
                      type="button"
                      variant="subtle"
                      size="sm"
                      disabled={busy}
                      onClick={() => restore(item)}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      <span>Restore</span>
                    </Button>
                    {canHardDelete && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirmTarget(item)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        <span>Delete forever</span>
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {confirmTarget && (
        <PermanentDeleteConfirm
          item={confirmTarget}
          busy={pending.has(confirmTarget.page_id)}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => hardDelete(confirmTarget)}
        />
      )}
    </>
  );
}

interface ConfirmProps {
  item: TrashItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function PermanentDeleteConfirm({
  item,
  busy,
  onCancel,
  onConfirm,
}: ConfirmProps) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === item.title.trim();
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="permanent-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete "{item.title}" forever?</DialogTitle>
          <DialogDescription>
            This permanently removes the page, every version, and any
            attachments + publication artifacts. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="permanent-delete-body">
          <label className="permanent-delete-label">
            Type the page title <strong>{item.title}</strong> to confirm:
          </label>
          <Input
            type="text"
            autoFocus
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={item.title}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="subtle"
            size="md"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="md"
            onClick={onConfirm}
            disabled={!matches || busy}
          >
            {busy ? "Deleting…" : "Delete forever"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
