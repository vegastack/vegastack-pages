// Move-to-folder modal. Uses the Nova design system primitives
// (Dialog / Input / Button) and the same Lucide icons the workspace
// sidebar uses (Folder for folders, FileText for the page being
// moved). Type-ahead search over a flat folder list, with "/" (root)
// always pinned as the first option.
//
// On submit, POST /api/pages/:id/move with `{ folder_path }`. The
// caller decides what to do on success (the sidebar kebab triggers a
// full reload to resync the tree; PageActionsMenu does the same).

import { Folder, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
    // Autofocus the search; Dialog handles the rest of the trap.
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  const allOptions = useMemo<FolderOption[]>(
    () => [{ id: "__root__", path: "/", name: "Workspace root" }, ...folders],
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
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="move-folder-dialog">
        <DialogHeader>
          <DialogTitle>Move "{title}"</DialogTitle>
          <DialogDescription>
            Choose a destination folder for this page.
          </DialogDescription>
        </DialogHeader>

        <div className="move-folder-search">
          <Search
            size={14}
            aria-hidden="true"
            className="move-folder-search-icon"
          />
          <Input
            ref={inputRef}
            type="text"
            placeholder="Search folders…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="move-folder-search-input"
          />
          {query && (
            <button
              type="button"
              className="move-folder-search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        <ul
          className="move-folder-list"
          role="listbox"
          aria-label="Destination folder"
        >
          {filtered.length === 0 ? (
            <li className="move-folder-empty">No folders match "{query}".</li>
          ) : (
            filtered.map((option) => {
              const selected = selectedPath === option.path;
              return (
                <li
                  key={option.id}
                  role="option"
                  aria-selected={selected}
                  className="move-folder-item"
                  data-selected={selected ? "true" : undefined}
                  onClick={() => setSelectedPath(option.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedPath(option.path);
                    }
                  }}
                  tabIndex={0}
                >
                  <Folder
                    size={14}
                    aria-hidden="true"
                    className="move-folder-item-icon"
                  />
                  <span className="move-folder-item-path">
                    {option.path === "/" ? "Workspace root" : option.path}
                  </span>
                </li>
              );
            })
          )}
        </ul>

        <DialogFooter>
          <Button
            type="button"
            variant="subtle"
            size="md"
            onClick={() => onClose(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
