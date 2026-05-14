import { AppError } from "./errors";
import { createId, idPrefixes } from "./ids";
import { hasPermission, type PermissionLevel } from "./permissions";
import type { PublicationPermission } from "./publications";
import type {
  UserRecord,
  WorkspaceMemberRecord,
  WorkspaceRole,
} from "./workspaces";

export type GrantScope = "workspace" | "folder" | "page";
export type PermissionRecord = {
  id: string;
  workspaceId: string;
  subjectType: "user";
  subjectId: string;
  scope: GrantScope;
  targetId: string;
  level: PermissionLevel;
  createdAt: string;
  updatedAt: string;
};

export function permissionForWorkspaceRole(
  role: WorkspaceRole,
): PermissionLevel {
  switch (role) {
    case "reader":
      return "read";
    case "commenter":
      return "comment";
    case "editor":
      return "write";
    case "admin":
      return "admin";
  }
}

export function permissionForPublication(
  permission: PublicationPermission,
): PermissionLevel {
  switch (permission) {
    case "view":
      return "read";
    case "comment":
      return "comment";
    case "edit":
      return "write";
  }
}

export class PermissionService {
  private readonly grants = new Map<string, PermissionRecord>();

  setGrant(input: {
    id?: string;
    workspaceId: string;
    subjectId: string;
    scope: GrantScope;
    targetId: string;
    level: PermissionLevel;
  }): PermissionRecord {
    const now = new Date().toISOString();
    const existing = [...this.grants.values()].find(
      (grant) =>
        grant.workspaceId === input.workspaceId &&
        grant.subjectId === input.subjectId &&
        grant.scope === input.scope &&
        grant.targetId === input.targetId,
    );
    const grant: PermissionRecord = {
      id: existing?.id ?? input.id ?? createId(idPrefixes.permission),
      workspaceId: input.workspaceId,
      subjectType: "user",
      subjectId: input.subjectId,
      scope: input.scope,
      targetId: input.targetId,
      level: input.level,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  listGrants(input: {
    workspaceId: string;
    subjectId?: string;
    scope?: GrantScope;
    targetId?: string;
  }): PermissionRecord[] {
    return [...this.grants.values()]
      .filter((grant) => grant.workspaceId === input.workspaceId)
      .filter((grant) =>
        input.subjectId ? grant.subjectId === input.subjectId : true,
      )
      .filter((grant) => (input.scope ? grant.scope === input.scope : true))
      .filter((grant) =>
        input.targetId ? grant.targetId === input.targetId : true,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  deleteGrant(grantId: string): PermissionRecord {
    const grant = this.grants.get(grantId);
    if (!grant)
      throw new AppError(
        "PERMISSION_DENIED",
        "Permission grant was not found.",
        404,
      );
    this.grants.delete(grantId);
    return grant;
  }

  deleteGrantsForSubject(input: {
    workspaceId: string;
    subjectId: string;
  }): PermissionRecord[] {
    const deleted: PermissionRecord[] = [];
    for (const grant of this.listGrants({
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
    })) {
      this.grants.delete(grant.id);
      deleted.push(grant);
    }
    return deleted;
  }

  resolve(input: {
    user?: UserRecord | null;
    member?: WorkspaceMemberRecord | null;
    workspaceId: string;
    folderAncestorIds?: string[];
    pageId?: string;
    publicationPermission?: PublicationPermission | null;
  }): PermissionLevel {
    if (input.user?.role === "instance_admin") return "admin";

    let effective: PermissionLevel = input.member
      ? permissionForWorkspaceRole(input.member.role)
      : "none";

    if (input.user) {
      const scopedGrants = [...this.grants.values()].filter(
        (grant) =>
          grant.workspaceId === input.workspaceId &&
          grant.subjectId === input.user?.id,
      );
      const workspaceGrant = scopedGrants.find(
        (grant) =>
          grant.scope === "workspace" && grant.targetId === input.workspaceId,
      );
      if (workspaceGrant) effective = workspaceGrant.level;

      for (const folderId of input.folderAncestorIds ?? []) {
        const folderGrant = scopedGrants.find(
          (grant) => grant.scope === "folder" && grant.targetId === folderId,
        );
        if (folderGrant) effective = folderGrant.level;
      }

      const pageGrant = input.pageId
        ? scopedGrants.find(
            (grant) =>
              grant.scope === "page" && grant.targetId === input.pageId,
          )
        : null;
      if (pageGrant) effective = pageGrant.level;
    }

    if (effective === "none" && input.publicationPermission) {
      return permissionForPublication(input.publicationPermission);
    }

    return effective;
  }

  assert(input: {
    actual: PermissionLevel;
    required: PermissionLevel;
    message?: string;
  }): void {
    if (!hasPermission(input.actual, input.required)) {
      throw new AppError(
        "PERMISSION_DENIED",
        input.message ?? "Permission denied.",
        403,
        {
          required: input.required,
          actual: input.actual,
        },
      );
    }
  }
}
