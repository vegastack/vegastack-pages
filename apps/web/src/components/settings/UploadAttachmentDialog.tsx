import { Upload } from "lucide-react";
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

type PageOption = { id: string; label: string };

type UploadAttachmentDialogProps = {
  workspaceId: string;
  pages: PageOption[];
};

export function UploadAttachmentDialog({
  workspaceId,
  pages,
}: UploadAttachmentDialogProps) {
  const [open, setOpen] = useState(false);
  const [pageId, setPageId] = useState(pages[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setStatus({ kind: "idle" });
      return;
    }
  }, [open]);

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!file || !pageId) return;
    const helpers = window.settingsHelpers;
    setStatus({ kind: "pending", message: "Uploading..." });
    setPending(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const response = await fetch(
        `/api/pages/${pageId}/attachments?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            content_type: file.type || "text/plain",
            base64_body: dataUrl.split(",")[1] ?? "",
          }),
        },
      );
      if (response.ok) {
        toast.success(`Attached ${file.name}`);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setOpen(false);
        helpers?.fadeReload?.();
      } else {
        const payload = await response.json().catch(() => null);
        const message = payload?.error?.message ?? "Upload failed.";
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
          <Upload size={14} aria-hidden="true" />
          <span>Upload file</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="vpg-dialog-form">
        <DialogHeader>
          <DialogTitle>Upload attachment</DialogTitle>
          <DialogDescription>
            Pick a page and a file. The attachment inherits that page's read
            permissions.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="vpg-dialog-body">
            <label className="vpg-field">
              <span>Page</span>
              <Select value={pageId} onValueChange={setPageId}>
                <SelectTrigger aria-label="Page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pages.map((page) => (
                    <SelectItem key={page.id} value={page.id}>
                      {page.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="vpg-field">
              <span>File</span>
              <Input
                ref={fileInputRef}
                type="file"
                required
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
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
              disabled={pending || !file}
              data-pending={pending ? "true" : undefined}
            >
              <span className="settings-button-label">Upload</span>
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
