import { AppError } from "./errors";
import { createId, idPrefixes, makeFolderSlugId, slugifyTitle } from "./ids";

export type InstanceRole = "user" | "instance_admin";
export type WorkspaceRole = "reader" | "commenter" | "editor" | "admin";

export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: InstanceRole;
  /** Free-form preferences (datetime today; other settings later).
      `null`/missing means "no override — fall through to defaults". */
  preferencesJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  slug: string;
  versionRetentionDays: number | null;
  /** Workspace-default preferences. Same shape as UserRecord but
      applies to anyone reading the workspace who hasn't set their
      own override. */
  preferencesJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceMemberRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
};

export type FolderRecord = {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  slug: string;
  slugId: string;
  path: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceTree = {
  workspace: WorkspaceRecord;
  folders: FolderRecord[];
  pages: Array<{
    id: string;
    folderPath: string;
    title: string;
    slugId: string;
    position?: number;
  }>;
};

type FolderDirection = "up" | "down";

export class WorkspaceService {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly workspacesBySlug = new Map<string, string>();
  private readonly members = new Map<string, WorkspaceMemberRecord>();
  private readonly folders = new Map<string, FolderRecord>();
  private readonly foldersByShortId = new Map<string, string>();

  createUser(input: {
    id?: string;
    email: string;
    displayName: string;
    role?: InstanceRole;
  }): UserRecord {
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new AppError("VALIDATION_ERROR", "A valid email is required.", 400);
    }
    const existingId = this.usersByEmail.get(email);
    if (existingId) {
      const existing = this.users.get(existingId);
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: input.id ?? createId(idPrefixes.user),
      email,
      displayName: input.displayName.trim() || email,
      role: input.role ?? "user",
      preferencesJson: null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user.id);
    return user;
  }

  getUser(userId: string): UserRecord | null {
    return this.users.get(userId) ?? null;
  }

  getUserByEmail(email: string): UserRecord | null {
    const userId = this.usersByEmail.get(email.trim().toLowerCase());
    return userId ? this.getUser(userId) : null;
  }

  updateUser(input: { userId: string; displayName?: string }): UserRecord {
    const existing = this.users.get(input.userId);
    if (!existing)
      throw new AppError("AUTH_REQUIRED", "User was not found.", 404);
    const displayName =
      input.displayName === undefined
        ? existing.displayName
        : input.displayName.trim() || existing.email;
    const updated = {
      ...existing,
      displayName,
      updatedAt: new Date().toISOString(),
    };
    this.users.set(existing.id, updated);
    return updated;
  }

  listMembers(workspaceId: string): WorkspaceMemberRecord[] {
    return [...this.members.values()]
      .filter((member) => member.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  createWorkspace(input: {
    id?: string;
    name: string;
    slug?: string;
  }): WorkspaceRecord {
    const name = input.name.trim();
    if (!name)
      throw new AppError(
        "VALIDATION_ERROR",
        "Workspace name is required.",
        400,
      );
    const slug = slugifyTitle(input.slug ?? name);
    if (this.workspacesBySlug.has(slug)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Workspace slug is already in use.",
        400,
      );
    }

    const now = new Date().toISOString();
    const workspace: WorkspaceRecord = {
      id: input.id ?? createId(idPrefixes.workspace),
      name,
      slug,
      versionRetentionDays: null,
      preferencesJson: null,
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.set(workspace.id, workspace);
    this.workspacesBySlug.set(workspace.slug, workspace.id);
    return workspace;
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | null {
    return this.workspaces.get(workspaceId) ?? null;
  }

  updateWorkspace(input: {
    workspaceId: string;
    name?: string;
    slug?: string;
    versionRetentionDays?: number | null;
  }): WorkspaceRecord {
    const existing = this.workspaces.get(input.workspaceId);
    if (!existing)
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
      );

    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name)
      throw new AppError(
        "VALIDATION_ERROR",
        "Workspace name is required.",
        400,
      );

    const slug =
      input.slug === undefined
        ? existing.slug
        : slugifyTitle(input.slug || name);
    const existingSlugOwner = this.workspacesBySlug.get(slug);
    if (existingSlugOwner && existingSlugOwner !== existing.id) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Workspace slug is already in use.",
        400,
      );
    }

    if (slug !== existing.slug) {
      this.workspacesBySlug.delete(existing.slug);
      this.workspacesBySlug.set(slug, existing.id);
    }

    const updated = {
      ...existing,
      name,
      slug,
      versionRetentionDays:
        input.versionRetentionDays === undefined
          ? (existing.versionRetentionDays ?? null)
          : input.versionRetentionDays,
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(existing.id, updated);
    return updated;
  }

  listWorkspacesForUser(userId: string): WorkspaceRecord[] {
    const workspaceIds = [...this.members.values()]
      .filter((member) => member.userId === userId)
      .map((member) => member.workspaceId);
    return workspaceIds
      .map((id) => this.workspaces.get(id))
      .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));
  }

  listWorkspaces(): WorkspaceRecord[] {
    return [...this.workspaces.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  addMember(input: {
    id?: string;
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
  }): WorkspaceMemberRecord {
    if (!this.workspaces.has(input.workspaceId)) {
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
      );
    }
    if (!this.users.has(input.userId)) {
      throw new AppError("AUTH_REQUIRED", "User was not found.", 404);
    }

    const existing = [...this.members.values()].find(
      (member) =>
        member.workspaceId === input.workspaceId &&
        member.userId === input.userId,
    );
    if (existing) {
      const updated = {
        ...existing,
        role: input.role,
        updatedAt: new Date().toISOString(),
      };
      this.members.set(existing.id, updated);
      return updated;
    }

    const now = new Date().toISOString();
    const member: WorkspaceMemberRecord = {
      id: input.id ?? createId(idPrefixes.permission),
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    };
    this.members.set(member.id, member);
    return member;
  }

  getMember(workspaceId: string, userId: string): WorkspaceMemberRecord | null {
    return (
      [...this.members.values()].find(
        (member) =>
          member.workspaceId === workspaceId && member.userId === userId,
      ) ?? null
    );
  }

  getMemberById(memberId: string): WorkspaceMemberRecord | null {
    return this.members.get(memberId) ?? null;
  }

  updateMemberRole(input: {
    memberId: string;
    role: WorkspaceRole;
  }): WorkspaceMemberRecord {
    const existing = this.members.get(input.memberId);
    if (!existing)
      throw new AppError(
        "AUTH_REQUIRED",
        "Workspace member was not found.",
        404,
      );
    const updated = {
      ...existing,
      role: input.role,
      updatedAt: new Date().toISOString(),
    };
    this.members.set(existing.id, updated);
    return updated;
  }

  removeMember(memberId: string): WorkspaceMemberRecord {
    const existing = this.members.get(memberId);
    if (!existing)
      throw new AppError(
        "AUTH_REQUIRED",
        "Workspace member was not found.",
        404,
      );
    this.members.delete(memberId);
    return existing;
  }

  createFolder(input: {
    id?: string;
    workspaceId: string;
    parentFolderId?: string | null;
    name: string;
    position?: number;
  }): FolderRecord {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace)
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
      );

    const parent = input.parentFolderId
      ? this.folders.get(input.parentFolderId)
      : null;
    if (input.parentFolderId && !parent)
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder was not found.",
        404,
      );
    if (parent && parent.workspaceId !== input.workspaceId) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder does not belong to this workspace.",
        404,
      );
    }

    const name = input.name.trim();
    if (!name)
      throw new AppError("VALIDATION_ERROR", "Folder name is required.", 400);
    const id = input.id ?? createId(idPrefixes.folder);
    const slug = slugifyTitle(name);
    const slugId = makeFolderSlugId(name, id);
    const path = parent ? `${parent.path}/${slug}` : slug;
    const now = new Date().toISOString();
    const parentFolderId = parent?.id ?? null;
    const folder: FolderRecord = {
      id,
      workspaceId: input.workspaceId,
      parentFolderId,
      name,
      slug,
      slugId,
      path,
      position:
        input.position === undefined
          ? this.nextFolderPosition(input.workspaceId, parentFolderId)
          : normalizePosition(input.position),
      createdAt: now,
      updatedAt: now,
    };
    this.folders.set(folder.id, folder);
    this.foldersByShortId.set(
      slugId.slice(slugId.lastIndexOf("-") + 1),
      folder.id,
    );
    return folder;
  }

  updateFolder(input: {
    folderId: string;
    name?: string;
    parentFolderId?: string | null;
    position?: number;
  }): {
    previous: FolderRecord;
    folder: FolderRecord;
  } {
    const existing = this.folders.get(input.folderId);
    if (!existing)
      throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
    const parentFolderId =
      input.parentFolderId === undefined
        ? existing.parentFolderId
        : input.parentFolderId;
    const parent = parentFolderId ? this.folders.get(parentFolderId) : null;
    if (parentFolderId && !parent)
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder was not found.",
        404,
      );
    if (parent && parent.workspaceId !== existing.workspaceId) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Parent folder does not belong to this workspace.",
        404,
      );
    }
    if (
      parent?.id === existing.id ||
      parent?.path.startsWith(`${existing.path}/`)
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Folder cannot be moved inside itself.",
        400,
      );
    }

    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name)
      throw new AppError("VALIDATION_ERROR", "Folder name is required.", 400);
    const slug = slugifyTitle(name);
    const slugId = makeFolderSlugId(name, existing.id);
    const path = parent ? `${parent.path}/${slug}` : slug;
    const position =
      input.position === undefined
        ? parentFolderId === existing.parentFolderId
          ? existing.position
          : this.nextFolderPosition(
              existing.workspaceId,
              parent?.id ?? null,
              existing.id,
            )
        : normalizePosition(input.position);
    const folder: FolderRecord = {
      ...existing,
      parentFolderId: parent?.id ?? null,
      name,
      slug,
      slugId,
      path,
      position,
      updatedAt: new Date().toISOString(),
    };
    this.folders.set(folder.id, folder);
    this.foldersByShortId.delete(
      existing.slugId.slice(existing.slugId.lastIndexOf("-") + 1),
    );
    this.foldersByShortId.set(
      slugId.slice(slugId.lastIndexOf("-") + 1),
      existing.id,
    );

    for (const child of [...this.folders.values()]) {
      if (child.id === folder.id || !child.path.startsWith(`${existing.path}/`))
        continue;
      const childPath = `${folder.path}${child.path.slice(existing.path.length)}`;
      const childParent = child.parentFolderId
        ? this.folders.get(child.parentFolderId)
        : null;
      this.folders.set(child.id, {
        ...child,
        path: childPath,
        updatedAt: folder.updatedAt,
        parentFolderId: childParent?.id ?? child.parentFolderId,
      });
    }

    return { previous: existing, folder };
  }

  reorderFolder(input: { folderId: string; direction: FolderDirection }): {
    folder: FolderRecord;
    siblings: FolderRecord[];
  } {
    const existing = this.folders.get(input.folderId);
    if (!existing)
      throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
    const siblings = this.folderSiblings(
      existing.workspaceId,
      existing.parentFolderId,
    );
    const index = siblings.findIndex((folder) => folder.id === existing.id);
    const targetIndex = input.direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) {
      return { folder: existing, siblings };
    }

    const reordered = [...siblings];
    const [target] = reordered.splice(index, 1);
    if (!target) return { folder: existing, siblings };
    reordered.splice(targetIndex, 0, target);
    const updated = this.applyFolderSiblingOrder(reordered);
    const folder = updated.find((item) => item.id === existing.id) ?? existing;
    return { folder, siblings: updated };
  }

  deleteFolder(folderId: string): FolderRecord {
    const existing = this.folders.get(folderId);
    if (!existing)
      throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
    const hasChildren = [...this.folders.values()].some(
      (folder) => folder.parentFolderId === existing.id,
    );
    if (hasChildren) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Folder must be empty before it can be deleted.",
        400,
      );
    }
    this.folders.delete(folderId);
    this.foldersByShortId.delete(
      existing.slugId.slice(existing.slugId.lastIndexOf("-") + 1),
    );
    return existing;
  }

  getFolder(folderId: string): FolderRecord | null {
    return this.folders.get(folderId) ?? null;
  }

  getFolderBySlugId(slugId: string): FolderRecord | null {
    const shortId = slugId.slice(slugId.lastIndexOf("-") + 1);
    const folderId = this.foldersByShortId.get(shortId);
    return folderId ? (this.folders.get(folderId) ?? null) : null;
  }

  listFolders(workspaceId: string): FolderRecord[] {
    const folders = [...this.folders.values()].filter(
      (folder) => folder.workspaceId === workspaceId,
    );
    const folderIds = new Set(folders.map((folder) => folder.id));
    const childrenByParent = new Map<string | null, FolderRecord[]>();
    for (const folder of folders) {
      const parentId =
        folder.parentFolderId && folderIds.has(folder.parentFolderId)
          ? folder.parentFolderId
          : null;
      const children = childrenByParent.get(parentId) ?? [];
      children.push(folder);
      childrenByParent.set(parentId, children);
    }

    const ordered: FolderRecord[] = [];
    const seen = new Set<string>();
    const visit = (parentId: string | null) => {
      const siblings = childrenByParent
        .get(parentId)
        ?.slice()
        .sort(compareFolderSiblings);
      for (const folder of siblings ?? []) {
        if (seen.has(folder.id)) continue;
        seen.add(folder.id);
        ordered.push(folder);
        visit(folder.id);
      }
    };
    visit(null);
    for (const folder of folders.slice().sort(compareFolderSiblings)) {
      if (!seen.has(folder.id)) ordered.push(folder);
    }
    return ordered;
  }

  folderAncestors(folderId: string | null | undefined): FolderRecord[] {
    const ancestors: FolderRecord[] = [];
    let current = folderId ? this.folders.get(folderId) : null;
    while (current) {
      ancestors.unshift(current);
      current = current.parentFolderId
        ? (this.folders.get(current.parentFolderId) ?? null)
        : null;
    }
    return ancestors;
  }

  tree(input: {
    workspaceId: string;
    pages: WorkspaceTree["pages"];
    visiblePageIds?: Set<string>;
  }): WorkspaceTree {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace)
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
      );
    const pages = input.visiblePageIds
      ? input.pages.filter((page) => input.visiblePageIds?.has(page.id))
      : input.pages;
    return {
      workspace,
      folders: this.listFolders(input.workspaceId),
      pages: pages.sort(
        (left, right) =>
          left.folderPath.localeCompare(right.folderPath) ||
          left.title.localeCompare(right.title),
      ),
    };
  }

  private folderSiblings(
    workspaceId: string,
    parentFolderId: string | null,
    excludeFolderId?: string,
  ) {
    return [...this.folders.values()]
      .filter(
        (folder) =>
          folder.workspaceId === workspaceId &&
          folder.parentFolderId === parentFolderId &&
          folder.id !== excludeFolderId,
      )
      .sort(compareFolderSiblings);
  }

  private nextFolderPosition(
    workspaceId: string,
    parentFolderId: string | null,
    excludeFolderId?: string,
  ) {
    return (
      this.folderSiblings(workspaceId, parentFolderId, excludeFolderId).length +
      1
    );
  }

  private applyFolderSiblingOrder(siblings: FolderRecord[]) {
    const now = new Date().toISOString();
    return siblings.map((folder, index) => {
      const position = index + 1;
      const updated =
        folder.position === position
          ? folder
          : { ...folder, position, updatedAt: now };
      this.folders.set(folder.id, updated);
      return updated;
    });
  }
}

function normalizePosition(value: number) {
  return Math.max(1, Math.round(value));
}

function compareFolderSiblings(left: FolderRecord, right: FolderRecord) {
  return (
    left.position - right.position ||
    left.name.localeCompare(right.name) ||
    left.path.localeCompare(right.path) ||
    left.id.localeCompare(right.id)
  );
}
