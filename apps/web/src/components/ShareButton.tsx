import {
  CalendarDays,
  Copy,
  Globe2,
  Link,
  Share2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type ShareButtonProps = {
  workspaceId: string;
  resourceId: string;
  resourceSlugId: string;
  resourceType?: "page" | "folder";
};

type AccessLevel = "none" | "read" | "comment" | "write";
type ListedAccessLevel = AccessLevel | "admin";
type Member = {
  user_id: string;
  role: string;
  user: { email?: string; displayName?: string | null } | null;
};
type AccessGrant = {
  id: string;
  subject_id: string;
  level: ListedAccessLevel;
  user: { email?: string; displayName?: string | null } | null;
};
type Publication = {
  id: string;
  permission: "view" | "comment" | "edit";
  expires_at: string | null;
  password_enabled: boolean;
  indexing_enabled: boolean;
  url: string;
};

const accessLabels: Record<ListedAccessLevel, string> = {
  none: "No access",
  read: "View",
  comment: "Comment",
  write: "Edit",
  admin: "Admin",
};

export function ShareButton({
  workspaceId,
  resourceId,
  resourceSlugId,
  resourceType = "page",
}: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"members" | "publish">("members");
  const [permission, setPermission] = useState<"view" | "comment" | "edit">(
    "view",
  );
  const [expiresAt, setExpiresAt] = useState("");
  const [password, setPassword] = useState("");
  const [indexingEnabled, setIndexingEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [publication, setPublication] = useState<Publication | null>(null);
  const [publishPending, setPublishPending] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [accessMemberId, setAccessMemberId] = useState("");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("read");
  const [accessPending, setAccessPending] = useState(false);
  const resourceName = resourceType === "folder" ? "folder" : "page";
  const workspaceQuery = `workspace_id=${encodeURIComponent(workspaceId)}`;
  const accessEndpoint = `/api/${resourceType === "folder" ? "folders" : "pages"}/${resourceId}/access?${workspaceQuery}`;
  const publicationEndpoint = `/api/${resourceType === "folder" ? "folders" : "pages"}/${resourceId}/publication?${workspaceQuery}`;
  const canonicalPath = `/${resourceType === "folder" ? "f" : "p"}/${resourceSlugId}`;
  const publicUrl =
    url ||
    (typeof window === "undefined"
      ? canonicalPath
      : new URL(canonicalPath, window.location.origin).toString());
  const dialogDescription =
    resourceType === "folder"
      ? "Members are internal workspace access for this folder and pages inside it. Publish creates a public folder link that anyone with the link can open."
      : "Members are internal workspace access for this page. Publish creates a public page link that anyone with the link can open.";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function loadAccess() {
      const response = await fetch(accessEndpoint);
      if (cancelled) return;
      if (!response.ok) {
        toast.error("Access list failed.");
        return;
      }
      const payload = (await response.json()) as {
        members: Member[];
        grants: AccessGrant[];
      };
      setMembers(payload.members);
      setGrants(payload.grants);
      setAccessMemberId(
        (current) => current || payload.members[0]?.user_id || "",
      );
    }
    void loadAccess();
    async function loadPublication() {
      const response = await fetch(publicationEndpoint);
      if (cancelled) return;
      if (!response.ok) {
        toast.error("Publish state failed.");
        return;
      }
      const payload = (await response.json()) as {
        publication: Publication | null;
        url: string;
      };
      setPublication(payload.publication);
      setUrl(
        new URL(
          payload.publication?.url ?? payload.url,
          window.location.origin,
        ).toString(),
      );
      if (payload.publication) {
        setPermission(payload.publication.permission);
        setExpiresAt(
          payload.publication.expires_at
            ? localDateTimeValue(new Date(payload.publication.expires_at))
            : "",
        );
        setIndexingEnabled(payload.publication.indexing_enabled);
      } else {
        setPermission("view");
        setExpiresAt("");
        setIndexingEnabled(false);
        setPassword("");
      }
    }
    void loadPublication();
    return () => {
      cancelled = true;
    };
  }, [accessEndpoint, canonicalPath, open, publicationEndpoint]);

  async function copyPublicationUrl(nextUrl = url, notify = true) {
    const absoluteUrl = new URL(
      nextUrl || canonicalPath,
      window.location.origin,
    ).toString();
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      if (notify) toast.success("Public URL copied.");
      return true;
    } catch {
      if (notify) toast.error("Copy failed.");
      return false;
    }
  }

  async function savePublication() {
    setPublishPending(true);
    try {
      const wasPublished = Boolean(publication);
      const response = await fetch(publicationEndpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          permission,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
          ...(password ? { password } : publication ? {} : { password: null }),
          indexing_enabled: indexingEnabled,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error?.message ?? "Publish failed.");
        return;
      }
      const payload = (await response.json()) as {
        publication: Publication | null;
        url: string;
      };
      const absoluteUrl = new URL(
        payload.publication?.url ?? payload.url,
        window.location.origin,
      ).toString();
      setUrl(absoluteUrl);
      setPublication(payload.publication);
      setPassword("");
      const copied = await copyPublicationUrl(absoluteUrl, false);
      toast.success(
        copied
          ? wasPublished
            ? "Publish settings updated. URL copied."
            : `${resourceType === "folder" ? "Folder" : "Page"} published. URL copied.`
          : wasPublished
            ? "Publish settings updated."
            : `${resourceType === "folder" ? "Folder" : "Page"} published.`,
      );
    } finally {
      setPublishPending(false);
    }
  }

  async function unpublish() {
    setPublishPending(true);
    try {
      const response = await fetch(publicationEndpoint, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error?.message ?? "Unpublish failed.");
        return;
      }
      setPublication(null);
      toast.success("Publication removed.");
    } finally {
      setPublishPending(false);
    }
  }

  async function saveMemberAccess(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!accessMemberId) return;
    setAccessPending(true);
    try {
      const response = await fetch(accessEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject_id: accessMemberId,
          level: accessLevel,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error?.message ?? "Access update failed.");
        return;
      }
      const payload = (await response.json()) as { grant: AccessGrant };
      setGrants((current) => [
        payload.grant,
        ...current.filter((grant) => grant.id !== payload.grant.id),
      ]);
      setAccessMemberId("");
      setAccessLevel("read");
      toast.success("Access saved.");
    } finally {
      setAccessPending(false);
    }
  }

  async function updateMemberAccess(grant: AccessGrant, level: AccessLevel) {
    if (grant.level === level) return;
    setAccessPending(true);
    try {
      const response = await fetch(accessEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject_id: grant.subject_id,
          level,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error?.message ?? "Access update failed.");
        return;
      }
      const payload = (await response.json()) as { grant: AccessGrant };
      setGrants((current) =>
        current.map((currentGrant) =>
          currentGrant.id === grant.id ? payload.grant : currentGrant,
        ),
      );
      toast.success("Access updated.");
    } finally {
      setAccessPending(false);
    }
  }

  async function removeMemberAccess(grantId: string) {
    setAccessPending(true);
    try {
      const response = await fetch(accessEndpoint, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_id: grantId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error?.message ?? "Access removal failed.");
        return;
      }
      setGrants((current) => current.filter((grant) => grant.id !== grantId));
      toast.success("Access removed.");
    } finally {
      setAccessPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="vpg-pheader-btn vpg-pheader-share"
          type="button"
          aria-label={`Share ${resourceName}`}
          title={`Share ${resourceName}`}
        >
          <Share2 size={15} aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="share-panel">
        <DialogHeader>
          <DialogTitle>Share {resourceName}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as typeof activeTab)}
          className="share-tabs"
        >
          <TabsList aria-label="Share settings" className="share-tabs-list">
            <TabsTrigger value="members">
              <Users size={15} aria-hidden="true" />
              <span>Members</span>
            </TabsTrigger>
            <TabsTrigger value="publish">
              <Globe2 size={15} aria-hidden="true" />
              <span>Publish</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="share-tab-content">
            <section className="share-section" aria-label="Member access">
              <form
                id="share-access-form"
                className="share-access-form"
                onSubmit={saveMemberAccess}
              >
                <label className="vpg-field">
                  <span>Member</span>
                  <Select
                    value={accessMemberId}
                    onValueChange={setAccessMemberId}
                  >
                    <SelectTrigger aria-label="Member">
                      <SelectValue placeholder="Select member" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((member) => (
                        <SelectItem key={member.user_id} value={member.user_id}>
                          {member.user?.email ?? member.user_id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="vpg-field">
                  <span>Access</span>
                  <Select
                    value={accessLevel}
                    onValueChange={(value) =>
                      setAccessLevel(value as AccessLevel)
                    }
                  >
                    <SelectTrigger aria-label="Access">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No access</SelectItem>
                      <SelectItem value="read">View</SelectItem>
                      <SelectItem value="comment">Comment</SelectItem>
                      <SelectItem value="write">Edit</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </form>
              {grants.length > 0 ? (
                <div className="share-access-list">
                  {grants.map((grant) => (
                    <div className="share-access-row" key={grant.id}>
                      <span>{grant.user?.email ?? grant.subject_id}</span>
                      {grant.level === "admin" ? (
                        <strong>{accessLabels[grant.level]}</strong>
                      ) : (
                        <Select
                          value={grant.level}
                          disabled={accessPending}
                          onValueChange={(value) =>
                            void updateMemberAccess(grant, value as AccessLevel)
                          }
                        >
                          <SelectTrigger
                            className="share-access-select"
                            aria-label={`Access for ${grant.user?.email ?? grant.subject_id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No access</SelectItem>
                            <SelectItem value="read">View</SelectItem>
                            <SelectItem value="comment">Comment</SelectItem>
                            <SelectItem value="write">Edit</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      <button
                        type="button"
                        className="share-access-remove"
                        aria-label={`Remove access for ${grant.user?.email ?? grant.subject_id}`}
                        disabled={accessPending}
                        onClick={() => void removeMemberAccess(grant.id)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          </TabsContent>
          <TabsContent value="publish" className="share-tab-content">
            <section className="share-section" aria-label="Public publishing">
              <div className="vpg-field">
                <span id="share-visibility-label">Visibility</span>
                <Select
                  value={permission}
                  onValueChange={(value) =>
                    setPermission(value as typeof permission)
                  }
                >
                  <SelectTrigger aria-labelledby="share-visibility-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="view">View</SelectItem>
                    <SelectItem value="comment">Comment</SelectItem>
                    <SelectItem value="edit">Edit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="share-publish-row">
                <div className="vpg-field">
                  <span id="share-expires-label">Expires</span>
                  <ShareExpiryPicker
                    value={expiresAt}
                    onChange={setExpiresAt}
                    ariaLabelledBy="share-expires-label"
                  />
                </div>
                <label className="vpg-field" htmlFor="share-password">
                  <span>Password</span>
                  <Input
                    id="share-password"
                    autoComplete="new-password"
                    placeholder="Optional"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              </div>
              <label className="vpg-inline-check">
                <input
                  checked={indexingEnabled}
                  type="checkbox"
                  onChange={(event) => setIndexingEnabled(event.target.checked)}
                />
                <span>
                  Allow search engines to index this public {resourceName}
                </span>
              </label>
              <div className="share-url-row">
                <div className="share-url-display" aria-label="Public URL">
                  <span>{publicUrl}</span>
                </div>
                <button
                  type="button"
                  className="share-copy-btn"
                  aria-label="Copy public URL"
                  onClick={() => void copyPublicationUrl()}
                >
                  <Copy size={15} aria-hidden="true" />
                </button>
              </div>
            </section>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          {activeTab === "members" ? (
            <Button
              type="submit"
              form="share-access-form"
              variant="primary"
              disabled={accessPending || !accessMemberId}
            >
              <Users size={15} aria-hidden="true" />
              <span>Add access</span>
            </Button>
          ) : (
            <>
              {publication ? (
                <Button
                  type="button"
                  variant="subtle"
                  disabled={publishPending}
                  onClick={() => void unpublish()}
                >
                  Unpublish
                </Button>
              ) : null}
              <Button
                type="button"
                variant="primary"
                disabled={publishPending}
                onClick={() => void savePublication()}
              >
                <Link size={15} aria-hidden="true" />
                <span>{publication ? "Update publish" : "Publish"}</span>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ShareExpiryPickerProps = {
  value: string;
  onChange: (value: string) => void;
  ariaLabelledBy: string;
};

function ShareExpiryPicker({
  value,
  onChange,
  ariaLabelledBy,
}: ShareExpiryPickerProps) {
  const selected = parseLocalDateTime(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(
    startOfMonth(selected ?? new Date()),
  );
  const timeValue = selected ? formatTime(selected) : "23:59";

  function selectDate(day: Date) {
    const [hours, minutes] = timeValue.split(":").map(Number);
    onChange(
      localDateTimeValue(
        new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          Number.isFinite(hours) ? hours : 23,
          Number.isFinite(minutes) ? minutes : 59,
        ),
      ),
    );
  }

  function setTime(time: string) {
    if (!TIME_RE.test(time)) return;
    const base = selected ?? new Date();
    const [hours, minutes] = time.split(":").map(Number);
    onChange(
      localDateTimeValue(
        new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate(),
          hours,
          minutes,
        ),
      ),
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="share-date-trigger"
          aria-labelledby={ariaLabelledBy}
        >
          <span>
            {selected ? formatExpiryLabel(selected) : "No expiration"}
          </span>
          <CalendarDays size={15} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="share-date-popover" align="start">
        <Calendar
          mode="single"
          selected={selected ?? undefined}
          month={visibleMonth}
          onMonthChange={setVisibleMonth}
          onSelect={(day) => {
            if (!day) return;
            selectDate(day);
            setVisibleMonth(startOfMonth(day));
          }}
        />
        <div className="share-time-row">
          <label htmlFor="share-expiry-time">Time</label>
          <input
            id="share-expiry-time"
            className="share-time-input"
            inputMode="numeric"
            pattern="[0-9]{2}:[0-9]{2}"
            placeholder="23:59"
            value={timeValue}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>
        <div className="share-date-actions">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange("")}
          >
            <X size={14} aria-hidden="true" />
            <span>Clear</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="subtle"
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseLocalDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
}

function localDateTimeValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatTime(date: Date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatExpiryLabel(date: Date) {
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  return `${formattedDate} at ${formatTime(date)}`;
}
