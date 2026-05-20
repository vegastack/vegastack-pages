// Modal that lets the user move a page to a different folder.
// Folder list is pre-flattened on the server (FolderOption[]). A
// type-ahead search filters by path; selecting a row + clicking
// Move calls POST /api/pages/:id/move with `folder_path`. "/" (root)
// is always available as the first row.

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface FolderOption {
  id: string;
  /** Absolute folder path, e.g. "/Engineering/Runbooks". Root is "/". */
  path: string;
  name: string;
}

export interface MoveToFolderDialogProps {
  pageId: string;
  workspaceId: string;
  title: string;
  folders: FolderOption[];
  onClose: (moved: boolean) => void;
}

export function MoveToFolderDialog({
  pageId,
  workspaceId,
  title,
  folders,
  onClose,
}: MoveToFolderDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>("/");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const allOptions = useMemo<FolderOption[]>(
    () => [{ id: "__root__", path: "/", name: "/ (root)" }, ...folders],
    [folders],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter(
      (option) =>
        option.path.toLowerCase().includes(q) ||
        option.name.toLowerCase().includes(q),
    );
  }, [allOptions, query]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const body =
        selectedPath === "/"
          ? { folder_path: "" }
          : { folder_path: selectedPath.replace(/^\/+/, "") };
      const response = await fetch(
        `/api/pages/${pageId}/move?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? "Move failed.");
      }
      toast.success(`Moved "${title}"`);
      onClose(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Move failed.");
      setBusy(false);
    }
  }

  return (
    <div
      className="vpg-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Move ${title} to a folder`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose(false);
      }}
    >
      <div className="vpg-modal vpg-modal-md">
        <header className="vpg-modal-header">
          <h2 className="vpg-modal-title">Move "{title}" to…</h2>
        </header>
        <div className="vpg-modal-body">
          <input
            ref={inputRef}
            className="vpg-modal-search"
            type="text"
            placeholder="Search folders…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="vpg-folder-tree" role="listbox" aria-label="Folders">
            {filtered.length === 0 && (
              <li className="vpg-folder-empty">No folders match "{query}".</li>
            )}
            {filtered.map((option) => (
              <li
                key={option.id}
                role="option"
                aria-selected={selectedPath === option.path}
                className="vpg-folder-item"
                data-selected={
                  selectedPath === option.path ? "true" : undefined
                }
                onClick={() => setSelectedPath(option.path)}
              >
                <span className="vpg-folder-icon" aria-hidden="true">
                  📁
                </span>
                <span className="vpg-folder-path">
                  {option.path === "/" ? "/ (root)" : option.path}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <footer className="vpg-modal-footer">
          <button
            type="button"
            className="vpg-btn vpg-btn-secondary"
            onClick={() => onClose(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="vpg-btn vpg-btn-primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "Moving…" : "Move"}
          </button>
        </footer>
      </div>
    </div>
  );
}
