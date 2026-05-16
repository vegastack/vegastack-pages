// WorkspaceRepo — workspaces, users, members, and folders.
//
// Record types are imported from @vegastack/pages-core. The repo unifies
// these four resources because their access patterns are tightly coupled
// (a folder lookup almost always needs the workspace record, member
// resolution always needs the user, etc.).

import type {
  FolderRecord,
  UserRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRole,
} from "@vegastack/pages-core";

export type {
  FolderRecord,
  UserRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRole,
};

export type FolderDirection = "up" | "down";

export type CreateUserInput = {
  id?: string;
  email: string;
  displayName: string;
  role?: "user" | "instance_admin";
};

export type CreateWorkspaceInput = {
  id?: string;
  name: string;
  slug?: string;
  versionRetentionDays?: number | null;
};

export type CreateFolderInput = {
  id?: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  position?: number;
};

export type WorkspaceRepo = {
  // Users.
  createUser(input: CreateUserInput): Promise<UserRecord>;
  updateUser(input: {
    userId: string;
    displayName?: string;
  }): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;

  // Workspaces.
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  updateWorkspace(input: {
    workspaceId: string;
    name?: string;
    slug?: string;
    versionRetentionDays?: number | null;
  }): Promise<WorkspaceRecord>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  listWorkspacesForUser(userId: string): Promise<WorkspaceRecord[]>;

  // Members.
  addMember(input: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
  }): Promise<WorkspaceMemberRecord>;
  getMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null>;
  getMemberById(memberId: string): Promise<WorkspaceMemberRecord | null>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>;
  updateMemberRole(input: {
    memberId: string;
    role: WorkspaceRole;
  }): Promise<WorkspaceMemberRecord>;
  removeMember(memberId: string): Promise<WorkspaceMemberRecord>;

  // Folders.
  createFolder(input: CreateFolderInput): Promise<FolderRecord>;
  updateFolder(input: {
    folderId: string;
    name?: string;
    parentFolderId?: string | null;
    position?: number;
  }): Promise<{ folder: FolderRecord; previous: FolderRecord }>;
  reorderFolder(input: {
    folderId: string;
    direction: FolderDirection;
  }): Promise<{ folder: FolderRecord; siblings: FolderRecord[] }>;
  deleteFolder(folderId: string): Promise<FolderRecord>;
  getFolder(folderId: string): Promise<FolderRecord | null>;
  getFolderBySlugId(slugId: string): Promise<FolderRecord | null>;
  listFolders(workspaceId: string): Promise<FolderRecord[]>;
  folderAncestors(folderId: string | null | undefined): Promise<FolderRecord[]>;
};
