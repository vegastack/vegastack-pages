export const permissionLevels = [
  "none",
  "read",
  "comment",
  "write",
  "admin",
] as const;
export type PermissionLevel = (typeof permissionLevels)[number];

const permissionRank: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  comment: 2,
  write: 3,
  admin: 4,
};

export function comparePermissions(
  left: PermissionLevel,
  right: PermissionLevel,
): number {
  return permissionRank[left] - permissionRank[right];
}

export function hasPermission(
  actual: PermissionLevel,
  required: PermissionLevel,
): boolean {
  return comparePermissions(actual, required) >= 0;
}

export function permissionForShare(
  permission: "view" | "comment" | "edit",
): PermissionLevel {
  if (permission === "edit") return "write";
  if (permission === "comment") return "comment";
  return "read";
}

export type PermissionGrant = {
  level: PermissionLevel;
  scope: "instance" | "workspace" | "folder" | "page" | "share";
  explicitDeny?: boolean;
};

export function resolveEffectivePermission(
  grants: PermissionGrant[],
): PermissionLevel {
  let effective: PermissionLevel = "none";

  for (const grant of grants) {
    if (grant.explicitDeny || grant.level === "none") {
      return "none";
    }
    if (hasPermission(grant.level, effective)) {
      effective = grant.level;
    }
  }

  return effective;
}
