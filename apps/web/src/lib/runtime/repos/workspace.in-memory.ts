// In-memory WorkspaceRepo adapter.
//
// Wraps WorkspaceService for users/workspaces/members/folders. The
// existing service is entirely synchronous; the repo contract is async
// to match the eventual D1 implementation. Promise.resolve overhead is
// negligible.

import type {
  WorkspaceRepo,
  WorkspaceRecord,
  WorkspaceMemberRecord,
  UserRecord,
  FolderRecord,
  FolderDirection,
  CreateUserInput,
  CreateWorkspaceInput,
  CreateFolderInput,
  WorkspaceRole,
} from "@vegastack/pages-services";
import { workspaceService } from "../../runtime";

export function createInMemoryWorkspaceRepo(): WorkspaceRepo {
  return {
    async createUser(input: CreateUserInput): Promise<UserRecord> {
      return workspaceService.createUser({
        id: input.id,
        email: input.email,
        displayName: input.displayName,
        role: input.role,
      });
    },
    async updateUser(input: {
      userId: string;
      displayName?: string;
    }): Promise<UserRecord> {
      const updated = workspaceService.updateUser({
        userId: input.userId,
        displayName: input.displayName ?? "",
      });
      if (!updated) {
        throw new Error(`WorkspaceRepo: user ${input.userId} not found`);
      }
      return updated;
    },
    async getUser(userId: string): Promise<UserRecord | null> {
      return workspaceService.getUser(userId);
    },
    async getUserByEmail(email: string): Promise<UserRecord | null> {
      return workspaceService.getUserByEmail(email);
    },

    async createWorkspace(
      input: CreateWorkspaceInput,
    ): Promise<WorkspaceRecord> {
      // The legacy WorkspaceService.createWorkspace does not accept
      // versionRetentionDays at create-time. If provided, set it via a
      // follow-up updateWorkspace so the repo contract still works.
      const workspace = workspaceService.createWorkspace({
        id: input.id,
        name: input.name,
        slug: input.slug,
      });
      if (input.versionRetentionDays !== undefined) {
        return workspaceService.updateWorkspace({
          workspaceId: workspace.id,
          versionRetentionDays: input.versionRetentionDays,
        });
      }
      return workspace;
    },
    async updateWorkspace(input: {
      workspaceId: string;
      name?: string;
      slug?: string;
      versionRetentionDays?: number | null;
    }): Promise<WorkspaceRecord> {
      return workspaceService.updateWorkspace({
        workspaceId: input.workspaceId,
        name: input.name,
        slug: input.slug,
        versionRetentionDays: input.versionRetentionDays,
      });
    },
    async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
      return workspaceService.getWorkspace(workspaceId);
    },
    async listWorkspaces(): Promise<WorkspaceRecord[]> {
      return workspaceService.listWorkspaces();
    },
    async listWorkspacesForUser(userId: string): Promise<WorkspaceRecord[]> {
      return workspaceService.listWorkspacesForUser(userId);
    },

    async addMember(input: {
      workspaceId: string;
      userId: string;
      role: WorkspaceRole;
    }): Promise<WorkspaceMemberRecord> {
      return workspaceService.addMember(input);
    },
    async getMember(
      workspaceId: string,
      userId: string,
    ): Promise<WorkspaceMemberRecord | null> {
      return workspaceService.getMember(workspaceId, userId);
    },
    async getMemberById(
      memberId: string,
    ): Promise<WorkspaceMemberRecord | null> {
      return workspaceService.getMemberById(memberId);
    },
    async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
      return workspaceService.listMembers(workspaceId);
    },
    async updateMemberRole(input: {
      memberId: string;
      role: WorkspaceRole;
    }): Promise<WorkspaceMemberRecord> {
      return workspaceService.updateMemberRole(input);
    },
    async removeMember(memberId: string): Promise<WorkspaceMemberRecord> {
      return workspaceService.removeMember(memberId);
    },

    async createFolder(input: CreateFolderInput): Promise<FolderRecord> {
      return workspaceService.createFolder({
        id: input.id,
        workspaceId: input.workspaceId,
        parentFolderId: input.parentFolderId,
        name: input.name,
        position: input.position,
      });
    },
    async updateFolder(input: {
      folderId: string;
      name?: string;
      parentFolderId?: string | null;
      position?: number;
    }): Promise<{ folder: FolderRecord; previous: FolderRecord }> {
      return workspaceService.updateFolder(input);
    },
    async reorderFolder(input: {
      folderId: string;
      direction: FolderDirection;
    }): Promise<{ folder: FolderRecord; siblings: FolderRecord[] }> {
      return workspaceService.reorderFolder(input);
    },
    async deleteFolder(folderId: string): Promise<FolderRecord> {
      return workspaceService.deleteFolder(folderId);
    },
    async getFolder(folderId: string): Promise<FolderRecord | null> {
      return workspaceService.getFolder(folderId);
    },
    async getFolderBySlugId(slugId: string): Promise<FolderRecord | null> {
      return workspaceService.getFolderBySlugId(slugId);
    },
    async listFolders(workspaceId: string): Promise<FolderRecord[]> {
      return workspaceService.listFolders(workspaceId);
    },
    async folderAncestors(
      folderId: string | null | undefined,
    ): Promise<FolderRecord[]> {
      return workspaceService.folderAncestors(folderId);
    },
  };
}
