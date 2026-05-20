// Trash list shared between /app/trash (user scope) and
// /app/settings/recovery (workspace scope). Renders the rows we
// already get back from GET /api/workspaces/:id/trash and exposes
// Restore + Delete forever actions on each row.
//
// Permissions are enforced server-side; the UI hides
// "Delete forever" when `canHardDelete` is false. Restore is open to
// everyone with edit on the workspace (matches the decision in the
// feature interview).
//
// Delete-forever uses a confirm modal that requires the user to type
// the page title verbatim — matches GitHub's repo-delete pattern.
// Skipped for the user-scope view (those rows don't expose the
// hard-delete button at all).

import { useState } from "react";
import { toast } from "sonner";

// Minimal browser-local rendering of the trashed-at timestamp until
// the workspace-wide datetime preferences land. `toLocaleString()`
// already respects the viewer's locale + timezone, so admins see
// the time in their own zone rather than the raw UTC ISO.
function formatDeletedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
}

export function TrashList({
  scope,
  workspaceId,
  items,
  canHardDelete,
}: TrashListProps) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [confirmTarget, setConfirmTarget] = useState<TrashItem | null>(null);

  const visibleItems = items.filter((item) => !removed.has(item.page_id));

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
                  <div className="vpg-trash-title">{item.title}</div>
                  {item.folder_path && (
                    <div className="vpg-trash-folder">{item.folder_path}</div>
                  )}
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
                    {formatDeletedAt(item.deleted_at)}
                  </time>
                </td>
                <td className="settings-actions-cell">
                  <div className="settings-row-actions-group">
                    <button
                      type="button"
                      className="vpg-btn vpg-btn-secondary"
                      disabled={busy}
                      onClick={() => restore(item)}
                    >
                      Restore
                    </button>
                    {canHardDelete && (
                      <button
                        type="button"
                        className="vpg-btn vpg-btn-danger"
                        disabled={busy}
                        onClick={() => setConfirmTarget(item)}
                      >
                        Delete forever
                      </button>
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
    <div
      className="vpg-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Permanently delete ${item.title}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="vpg-modal vpg-modal-sm">
        <header className="vpg-modal-header">
          <h2 className="vpg-modal-title">Delete "{item.title}" forever?</h2>
        </header>
        <div className="vpg-modal-body">
          <p>
            This permanently removes the page, every version, and any
            attachments + publication artifacts. It cannot be undone.
          </p>
          <p>
            Type the page title <strong>{item.title}</strong> to confirm:
          </p>
          <input
            className="vpg-modal-search"
            type="text"
            autoFocus
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={item.title}
          />
        </div>
        <footer className="vpg-modal-footer">
          <button
            type="button"
            className="vpg-btn vpg-btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="vpg-btn vpg-btn-danger"
            onClick={onConfirm}
            disabled={!matches || busy}
          >
            {busy ? "Deleting…" : "Delete forever"}
          </button>
        </footer>
      </div>
    </div>
  );
}
