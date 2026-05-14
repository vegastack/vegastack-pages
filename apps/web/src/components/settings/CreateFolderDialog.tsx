import { FolderPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type Status =
  | { kind: "idle" }
  | { kind: "pending" | "success" | "error"; message: string };

type FolderOption = { id: string; path: string };

type CreateFolderDialogProps = {
  workspaceId: string;
  folders: FolderOption[];
  openOnLoad?: boolean;
};

const ROOT_PARENT_VALUE = "__root__";

export function CreateFolderDialog({
  workspaceId,
  folders,
  openOnLoad = false,
}: CreateFolderDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string>(ROOT_PARENT_VALUE);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!openOnLoad) return;
    setOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("focus");
    window.history.replaceState({}, "", url.toString());
  }, [openOnLoad]);

  useEffect(() => {
    if (!open) {
      setStatus({ kind: "idle" });
      return;
    }
    queueMicrotask(() => firstFieldRef.current?.focus());
  }, [open]);

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();
    const helpers = window.settingsHelpers;
    setStatus({ kind: "pending", message: "Creating..." });
    setPending(true);
    try {
      const parentFolderId = parent === ROOT_PARENT_VALUE ? null : parent;
      const response = await fetch(`/api/workspaces/${workspaceId}/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
      });
      if (response.ok) {
        toast.success("Folder created");
        setName("");
        setParent(ROOT_PARENT_VALUE);
        setOpen(false);
        helpers?.fadeReload?.();
      } else {
        const payload = await response.json().catch(() => null);
        const message = payload?.error?.message ?? "Folder creation failed.";
        setStatus({ kind: "error", message });
        toast.error(message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="primary" size="md">
          <FolderPlus size={14} aria-hidden="true" />
          <span>New folder</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="vpg-dialog-form">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Choose a name and an optional parent. Folders can nest one level
            deep or more.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="vpg-dialog-body">
            <label className="vpg-field">
              <span>Name</span>
              <Input
                ref={firstFieldRef}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Guides"
                autoComplete="off"
              />
            </label>
            <label className="vpg-field">
              <span>Parent</span>
              <Select value={parent} onValueChange={setParent}>
                <SelectTrigger aria-label="Parent folder">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT_PARENT_VALUE}>
                    No parent (top-level)
                  </SelectItem>
                  {folders.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {folder.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {status.kind !== "idle" && (
              <p className="settings-status" data-state={status.kind}>
                {status.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={pending}
              data-pending={pending ? "true" : undefined}
            >
              <span className="settings-button-label">Create folder</span>
              <span className="settings-button-spinner-wrap">
                <span className="settings-button-spinner" aria-hidden="true" />
              </span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
