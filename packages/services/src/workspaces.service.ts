// WorkspacesService — application logic for workspace/member/folder
// management.
//
// All mutating methods compute `tree_version` AFTER the write via
// `ctx.computeTreeVersion(workspaceId)` so clients always receive the
// post-mutation navigation hash.

import type { ServiceContext, MutationEnvelope } from "./context.ts";
import type {
  WorkspaceRecord,
  WorkspaceMemberRecord,
  UserRecord,
  FolderRecord,
  WorkspaceRole,
  CreateFolderInput,
} from "./repo/workspace.repo.ts";
import { ServiceError } from "./errors.ts";
import { buildEnvelope } from "./envelope.ts";

export type WorkspaceMutation<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

export async function whoami(ctx: ServiceContext): Promise<{
  user: UserRecord | null;
  workspaces: WorkspaceRecord[];
}> {
  if (!ctx.actor.userId) {
    return { user: null, workspaces: [] };
  }
  const user = await ctx.repo.workspaces.getUser(ctx.actor.userId);
  if (!user) {
    return { user: null, workspaces: [] };
  }
  const workspaces = await ctx.repo.workspaces.listWorkspacesForUser(user.id);
  return { user, workspaces };
}

export async function list(ctx: ServiceContext): Promise<WorkspaceRecord[]> {
  if (!ctx.actor.userId) return [];
  return ctx.repo.workspaces.listWorkspacesForUser(ctx.actor.userId);
}

export async function get(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<WorkspaceRecord> {
  const workspace = await ctx.repo.workspaces.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new ServiceError("NOT_FOUND", "Workspace was not found.");
  }
  return workspace;
}

export async function listMembers(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<WorkspaceMemberRecord[]> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in required.");
  }
  return ctx.repo.workspaces.listMembers(input.workspaceId);
}

export async function updateMemberRole(
  ctx: ServiceContext,
  input: {
    memberId: string;
    role: WorkspaceRole;
  },
): Promise<WorkspaceMutation<WorkspaceMemberRecord>> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in required.");
  }
  const target = await ctx.repo.workspaces.getMemberById(input.memberId);
  if (!target) {
    throw new ServiceError("NOT_FOUND", "Workspace member was not found.");
  }
  const updated = await ctx.repo.workspaces.updateMemberRole({
    memberId: input.memberId,
    role: input.role,
  });
  const treeVersion = await ctx.computeTreeVersion(target.workspaceId);
  return {
    data: updated,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `members:${target.workspaceId}`,
        `member:${updated.id}`,
      ],
    }),
  };
}

export async function removeMember(
  ctx: ServiceContext,
  input: { memberId: string },
): Promise<WorkspaceMutation<WorkspaceMemberRecord>> {
  if (!ctx.actor.userId) {
    throw new ServiceError("UNAUTHORIZED", "Sign in required.");
  }
  const target = await ctx.repo.workspaces.getMemberById(input.memberId);
  if (!target) {
    throw new ServiceError("NOT_FOUND", "Workspace member was not found.");
  }
  const removed = await ctx.repo.workspaces.removeMember(input.memberId);
  const treeVersion = await ctx.computeTreeVersion(target.workspaceId);
  return {
    data: removed,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `members:${target.workspaceId}`,
        `member:${removed.id}`,
      ],
    }),
  };
}

export async function createFolder(
  ctx: ServiceContext,
  input: CreateFolderInput,
): Promise<WorkspaceMutation<FolderRecord>> {
  const folder = await ctx.repo.workspaces.createFolder({
    id: input.id,
    workspaceId: input.workspaceId,
    parentFolderId: input.parentFolderId,
    name: input.name,
    position: input.position,
  });
  const treeVersion = await ctx.computeTreeVersion(folder.workspaceId);
  return {
    data: folder,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`folder:${folder.id}`],
    }),
  };
}

export async function updateFolder(
  ctx: ServiceContext,
  input: {
    folderId: string;
    name?: string;
    parentFolderId?: string | null;
    position?: number;
  },
): Promise<
  WorkspaceMutation<{ folder: FolderRecord; previous: FolderRecord }>
> {
  const result = await ctx.repo.workspaces.updateFolder({
    folderId: input.folderId,
    name: input.name,
    parentFolderId: input.parentFolderId,
    position: input.position,
  });
  const treeVersion = await ctx.computeTreeVersion(result.folder.workspaceId);
  return {
    data: result,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`folder:${result.folder.id}`],
    }),
  };
}

export async function deleteFolder(
  ctx: ServiceContext,
  input: { folderId: string },
): Promise<WorkspaceMutation<FolderRecord>> {
  const deleted = await ctx.repo.workspaces.deleteFolder(input.folderId);
  const treeVersion = await ctx.computeTreeVersion(deleted.workspaceId);
  return {
    data: deleted,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [`folder:${deleted.id}`],
    }),
  };
}

export async function reorderFolder(
  ctx: ServiceContext,
  input: {
    folderId: string;
    direction: "up" | "down";
  },
): Promise<
  WorkspaceMutation<{ folder: FolderRecord; siblings: FolderRecord[] }>
> {
  const result = await ctx.repo.workspaces.reorderFolder({
    folderId: input.folderId,
    direction: input.direction,
  });
  const treeVersion = await ctx.computeTreeVersion(result.folder.workspaceId);
  return {
    data: result,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: true,
      changedResources: [
        `folder:${result.folder.id}`,
        ...result.siblings.map((entry) => `folder:${entry.id}`),
      ],
    }),
  };
}

export async function listFolders(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<FolderRecord[]> {
  return ctx.repo.workspaces.listFolders(input.workspaceId);
}
