import { LogOut, Search, Trash2, UserRoundPen } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { WorkspaceRole } from "@vegastack/pages-core";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type MemberUser = {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "instance_admin";
};

type MemberRow = {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
  user: MemberUser | null;
};

type PendingRoleChange = {
  member: MemberRow;
  role: WorkspaceRole;
};

const roleLabels: Record<WorkspaceRole, string> = {
  reader: "Reader",
  commenter: "Commenter",
  editor: "Editor",
  admin: "Admin",
};

const roleDescriptions: Record<WorkspaceRole, string> = {
  reader: "View pages",
  commenter: "View and comment",
  editor: "Create and edit pages",
  admin: "Manage workspace",
};

const roles: WorkspaceRole[] = ["reader", "commenter", "editor", "admin"];

type WorkspaceMembersManagerProps = {
  workspaceId: string;
  currentUserId: string;
  initialMembers: MemberRow[];
};

export function WorkspaceMembersManager({
  workspaceId,
  currentUserId,
  initialMembers,
}: WorkspaceMembersManagerProps) {
  const [members, setMembers] = useState<MemberRow[]>(initialMembers);
  const [query, setQuery] = useState("");
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [pendingRoleChange, setPendingRoleChange] =
    useState<PendingRoleChange | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<MemberRow | null>(null);
  const [pendingLeave, setPendingLeave] = useState<MemberRow | null>(null);
  const [pendingEdit, setPendingEdit] = useState<MemberRow | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");

  const adminCount = members.filter((member) => member.role === "admin").length;
  const filteredMembers = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return members;
    return members.filter((member) => {
      const user = member.user;
      return [
        user?.displayName,
        user?.email,
        member.role,
        roleLabels[member.role],
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(value));
    });
  }, [members, query]);

  function memberName(member: MemberRow) {
    return member.user?.displayName || member.user?.email || member.userId;
  }

  function memberEmail(member: MemberRow) {
    return member.user?.email || member.userId;
  }

  function isCurrentMember(member: MemberRow) {
    return member.userId === currentUserId;
  }

  function isLastAdmin(member: MemberRow) {
    return member.role === "admin" && adminCount <= 1;
  }

  function updateMemberInState(member: MemberRow) {
    setMembers((current) =>
      current.map((item) => (item.id === member.id ? member : item)),
    );
  }

  function requestMemberEdit(member: MemberRow) {
    setEditDisplayName(member.user?.displayName ?? "");
    setPendingEdit(member);
  }

  async function saveMemberEdit() {
    if (!pendingEdit) return;

    setBusyMemberId(pendingEdit.id);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/members/${pendingEdit.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: pendingEdit.role,
            display_name: editDisplayName,
          }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Could not update member.");
      }
      updateMemberInState(payload.member);
      setPendingEdit(null);
      toast.success(`${memberName(payload.member)} updated.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Member update failed.",
      );
    } finally {
      setBusyMemberId(null);
    }
  }

  async function commitRole(member: MemberRow, role: WorkspaceRole) {
    if (role === member.role) return;
    if (isCurrentMember(member)) {
      toast.error("Use another workspace admin to change your own role.");
      return;
    }
    if (member.role === "admin" && role !== "admin" && isLastAdmin(member)) {
      toast.error("A workspace must keep at least one admin.");
      return;
    }

    setBusyMemberId(member.id);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/members/${member.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.error?.message ?? "Could not update member role.",
        );
      }
      updateMemberInState(payload.member);
      toast.success(
        `${memberName(payload.member)} is now ${roleLabels[role]}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Role update failed.",
      );
    } finally {
      setBusyMemberId(null);
    }
  }

  function requestRoleChange(member: MemberRow, role: WorkspaceRole) {
    if (role === member.role) return;
    if (member.role === "admin" && role !== "admin") {
      setPendingRoleChange({ member, role });
      return;
    }
    void commitRole(member, role);
  }

  async function leaveWorkspace(member: MemberRow) {
    if (!isCurrentMember(member)) return;
    if (isLastAdmin(member)) {
      toast.error(
        "Promote another admin before leaving — a workspace must keep at least one admin.",
      );
      return;
    }
    setBusyMemberId(member.id);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/leave`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.error?.message ?? "Could not leave the workspace.",
        );
      }
      toast.success("You left the workspace.");
      window.location.assign("/app");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Leaving workspace failed.",
      );
      setBusyMemberId(null);
      setPendingLeave(null);
    }
  }

  async function removeMember(member: MemberRow) {
    if (isCurrentMember(member)) {
      toast.error("You cannot remove yourself from the workspace.");
      return;
    }
    if (isLastAdmin(member)) {
      toast.error("A workspace must keep at least one admin.");
      return;
    }

    setBusyMemberId(member.id);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/members/${member.id}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Could not remove member.");
      }
      setMembers((current) => current.filter((item) => item.id !== member.id));
      const grants = Number(payload?.removed_grants ?? 0);
      const sessions = Number(payload?.revoked_mcp_sessions ?? 0);
      const details = [
        grants
          ? `${grants} permission ${grants === 1 ? "grant" : "grants"}`
          : "",
        sessions
          ? `${sessions} MCP ${sessions === 1 ? "session" : "sessions"}`
          : "",
      ]
        .filter(Boolean)
        .join(", ");
      toast.success(
        details
          ? `Removed ${memberName(member)} and revoked ${details}.`
          : `Removed ${memberName(member)}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Member removal failed.",
      );
    } finally {
      setBusyMemberId(null);
      setPendingRemoval(null);
    }
  }

  return (
    <div className="members-manager">
      <div className="members-toolbar">
        <label className="members-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search members</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search members"
            type="search"
          />
        </label>
      </div>

      <section
        className="settings-card settings-card-table"
        aria-label="Workspace members"
      >
        <div className="settings-table-wrap">
          <table className="settings-table members-table" aria-label="Members">
            <thead>
              <tr>
                <th>Member</th>
                <th className="settings-cell-fit">Role</th>
                <th className="settings-actions-cell" aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {filteredMembers.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <div className="settings-empty" role="status">
                      <div className="settings-empty-glyph" aria-hidden="true">
                        <UserRoundPen size={18} aria-hidden="true" />
                      </div>
                      <p>
                        <strong>No matching members</strong>
                        Adjust the search or invite a teammate.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredMembers.map((member) => {
                  const current = isCurrentMember(member);
                  const lastAdmin = isLastAdmin(member);
                  const busy = busyMemberId === member.id;
                  const roleLocked = current || lastAdmin;
                  const removeLocked = lastAdmin;
                  return (
                    <tr
                      data-pending={busy ? "true" : undefined}
                      key={member.id}
                    >
                      <td>
                        <div className="member-identity">
                          <span className="member-avatar" aria-hidden="true">
                            {memberName(member).slice(0, 1).toUpperCase()}
                          </span>
                          <div>
                            <div className="member-name-line">
                              <strong>{memberName(member)}</strong>
                              {current ? (
                                <span className="member-pill">You</span>
                              ) : null}
                            </div>
                            <span>{memberEmail(member)}</span>
                          </div>
                        </div>
                      </td>
                      <td className="member-role-cell settings-cell-fit">
                        <Select
                          value={member.role}
                          disabled={roleLocked || busy}
                          onValueChange={(value) =>
                            requestRoleChange(member, value as WorkspaceRole)
                          }
                        >
                          <SelectTrigger
                            className="settings-inline-select"
                            aria-label={`Role for ${memberEmail(member)}`}
                            title={
                              current
                                ? "Use another admin to change your role."
                                : lastAdmin
                                  ? "A workspace must keep at least one admin."
                                  : roleDescriptions[member.role]
                            }
                          >
                            {/* Render the label directly. Radix's SelectValue only
                              populates from ItemText after the dropdown's portal
                              has mounted at least once, which never happens for
                              locked rows (disabled trigger). Showing the label
                              inline guarantees it's visible in every state. */}
                            <SelectValue placeholder={roleLabels[member.role]}>
                              {roleLabels[member.role]}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {roles.map((role) => (
                              <SelectItem
                                key={role}
                                value={role}
                                title={roleDescriptions[role]}
                              >
                                {roleLabels[role]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="settings-actions-cell">
                        <div className="settings-row-actions-group">
                          <button
                            aria-label={`Edit ${memberEmail(member)}`}
                            className="settings-row-action"
                            disabled={busy}
                            onClick={() => requestMemberEdit(member)}
                            title="Edit member"
                            type="button"
                          >
                            <UserRoundPen size={16} aria-hidden="true" />
                          </button>
                          {current ? (
                            <button
                              aria-label="Leave workspace"
                              className="settings-row-action danger"
                              disabled={lastAdmin || busy}
                              onClick={() => setPendingLeave(member)}
                              title={
                                lastAdmin
                                  ? "Promote another admin before leaving."
                                  : "Leave workspace"
                              }
                              type="button"
                            >
                              <LogOut size={16} aria-hidden="true" />
                            </button>
                          ) : (
                            <button
                              aria-label={`Remove ${memberEmail(member)}`}
                              className="settings-row-action danger"
                              disabled={removeLocked || busy}
                              onClick={() => setPendingRemoval(member)}
                              title={
                                lastAdmin
                                  ? "A workspace must keep at least one admin."
                                  : "Remove member"
                              }
                              type="button"
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="members-dialogs">
        <Dialog
          open={Boolean(pendingEdit)}
          onOpenChange={(open) => {
            if (!open) setPendingEdit(null);
          }}
        >
          <DialogContent className="vpg-dialog-form">
            <DialogHeader>
              <DialogTitle>Edit member</DialogTitle>
              <DialogDescription>
                Update the display name shown in comments, audit logs, and
                member lists.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveMemberEdit();
              }}
            >
              <div className="vpg-dialog-body">
                <label className="vpg-field">
                  <span>Display name</span>
                  <Input
                    value={editDisplayName}
                    onChange={(event) => setEditDisplayName(event.target.value)}
                    placeholder={pendingEdit?.user?.email ?? "Display name"}
                    autoComplete="name"
                  />
                </label>
                {pendingEdit ? (
                  <p className="settings-help-text">
                    Email stays as {memberEmail(pendingEdit)}.
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setPendingEdit(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    pendingEdit ? busyMemberId === pendingEdit.id : false
                  }
                >
                  Save changes
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(pendingRoleChange)}
          onOpenChange={(open) => {
            if (!open) setPendingRoleChange(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change admin role?</DialogTitle>
              <DialogDescription>
                {pendingRoleChange
                  ? `${memberName(pendingRoleChange.member)} will lose workspace management access and become ${roleLabels[pendingRoleChange.role]}.`
                  : "This member will lose workspace management access."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPendingRoleChange(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  const next = pendingRoleChange;
                  setPendingRoleChange(null);
                  if (next) void commitRole(next.member, next.role);
                }}
              >
                Change role
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(pendingRemoval)}
          onOpenChange={(open) => {
            if (!open) setPendingRemoval(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove member?</DialogTitle>
              <DialogDescription>
                {pendingRemoval
                  ? `${memberName(pendingRemoval)} will lose workspace access. Explicit permissions and MCP sessions for this workspace will be revoked.`
                  : "This member will lose workspace access."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPendingRemoval(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (pendingRemoval) void removeMember(pendingRemoval);
                }}
              >
                Remove member
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(pendingLeave)}
          onOpenChange={(open) => {
            if (!open) setPendingLeave(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Leave workspace?</DialogTitle>
              <DialogDescription>
                You will lose access to this workspace. Explicit page
                permissions and your MCP sessions for this workspace will be
                revoked. An admin can re-invite you later.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPendingLeave(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (pendingLeave) void leaveWorkspace(pendingLeave);
                }}
              >
                Leave workspace
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
