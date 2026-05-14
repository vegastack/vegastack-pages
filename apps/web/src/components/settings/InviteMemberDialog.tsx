import { Copy, ExternalLink, UserPlus } from "lucide-react";
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

type InviteMemberDialogProps = {
  workspaceId: string;
  openOnLoad?: boolean;
};

export function InviteMemberDialog({
  workspaceId,
  openOnLoad = false,
}: InviteMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("reader");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [shouldReloadOnClose, setShouldReloadOnClose] = useState(false);
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
      setInviteLink(null);
      return;
    }
    queueMicrotask(() => firstFieldRef.current?.focus());
  }, [open]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen && shouldReloadOnClose) {
      setShouldReloadOnClose(false);
      window.settingsHelpers?.fadeReload?.();
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    toast.success("Invite link copied");
  }

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();
    const helpers = window.settingsHelpers;
    setStatus({ kind: "pending", message: "Sending invite..." });
    setPending(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role, display_name: displayName }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        const link = payload?.manual_verify_url ?? payload?.debug_verify_url;
        if (link) {
          setInviteLink(link);
          setShouldReloadOnClose(true);
          setStatus({
            kind: "success",
            message:
              payload?.delivery_warning ??
              "One-time sign-in link is ready to copy.",
          });
          toast.success("Invite link ready", {
            description:
              "Email delivery is not configured, so share this link manually.",
            action: {
              label: "Copy",
              onClick: () => void copyInviteLink(),
            },
          });
        } else {
          toast.success("Invite email sent");
          setEmail("");
          setDisplayName("");
          setRole("reader");
          setShouldReloadOnClose(false);
          setOpen(false);
          helpers?.fadeReload?.();
        }
      } else {
        const message = payload?.error?.message ?? "Invite failed.";
        setStatus({ kind: "error", message });
        toast.error(message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="primary" size="md">
          <UserPlus size={14} aria-hidden="true" />
          <span>Invite member</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="vpg-dialog-form">
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Send a one-time sign-in link. Re-invite an existing email to change
            their role. If email delivery is not configured, a manual link is
            generated.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="vpg-dialog-body">
            <label className="vpg-field">
              <span>Email address</span>
              <Input
                ref={firstFieldRef}
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="user@example.com"
                autoComplete="email"
              />
            </label>
            <label className="vpg-field">
              <span>Display name</span>
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Optional"
                autoComplete="name"
              />
            </label>
            <label className="vpg-field">
              <span>Role</span>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger aria-label="Member role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reader">Reader · view pages</SelectItem>
                  <SelectItem value="commenter">
                    Commenter · comment on pages
                  </SelectItem>
                  <SelectItem value="editor">
                    Editor · create and edit pages
                  </SelectItem>
                  <SelectItem value="admin">
                    Admin · manage workspace
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>
            {status.kind !== "idle" && status.kind !== "success" && (
              <p className="settings-status" data-state={status.kind}>
                {status.message}
              </p>
            )}
            {inviteLink ? (
              <div
                className="settings-manual-link"
                role="group"
                aria-label="Manual invite link"
              >
                <label>
                  <span>Manual sign-in link</span>
                  <Input
                    readOnly
                    value={inviteLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <div className="settings-manual-link-actions">
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    onClick={() => void copyInviteLink()}
                  >
                    <Copy size={13} aria-hidden="true" />
                    <span>Copy</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      window.location.href = inviteLink;
                    }}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                    <span>Open</span>
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => handleOpenChange(false)}
            >
              {inviteLink ? "Done" : "Cancel"}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={pending || Boolean(inviteLink)}
              data-pending={pending ? "true" : undefined}
            >
              <span className="settings-button-label">Send invite</span>
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
