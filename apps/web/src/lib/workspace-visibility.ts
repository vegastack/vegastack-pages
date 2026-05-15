import { hasPermission, type UserRecord } from "@vegastack/pages-core";
import {
  getRequestActor,
  resolveFolderActorPermission,
  type RequestActor,
} from "./access";
import { permissionService, workspaceService } from "./runtime";
import {
  actorCanUseWorkspace,
  buildWorkspaceNavigation,
  canReadFolderFromNavigation,
} from "./workspace-navigation";

export function resolveWorkspacePermission(
  user: UserRecord | null,
  workspaceId: string,
) {
  const member = user ? workspaceService.getMember(workspaceId, user.id) : null;
  return permissionService.resolve({
    user,
    member,
    workspaceId,
  });
}

export function listSelectableWorkspaces(user: UserRecord | null) {
  if (!user) return [];
  return workspaceService
    .listWorkspaces()
    .filter((workspace) =>
      hasPermission(resolveWorkspacePermission(user, workspace.id), "read"),
    );
}

export function listVisiblePagesForActor(
  actor: ReturnType<typeof getRequestActor> | RequestActor,
  workspaceId: string,
) {
  return buildWorkspaceNavigation(actor, workspaceId).visiblePages;
}

export function listVisibleFoldersForActor(
  actor: ReturnType<typeof getRequestActor> | RequestActor,
  workspaceId: string,
) {
  return buildWorkspaceNavigation(actor, workspaceId).visibleFolders;
}

export function canReadFolderOrVisibleDescendants(
  actor: ReturnType<typeof getRequestActor> | RequestActor,
  folderId: string,
) {
  const folder = workspaceService.getFolder(folderId);
  if (!folder) return false;
  if (!actorCanUseWorkspace(actor, folder.workspaceId)) return false;
  if (hasPermission(resolveFolderActorPermission({ actor, folder }), "read")) {
    return true;
  }
  return canReadFolderFromNavigation(
    buildWorkspaceNavigation(actor, folder.workspaceId),
    folderId,
  );
}

export function canReadWorkspaceOrScopedPages(
  actor: ReturnType<typeof getRequestActor> | RequestActor,
  workspaceId: string,
) {
  if (!actorCanUseWorkspace(actor, workspaceId)) return false;
  if (!actor.user) return false;
  if (
    hasPermission(resolveWorkspacePermission(actor.user, workspaceId), "read")
  ) {
    return true;
  }
  return listVisiblePagesForActor(actor, workspaceId).length > 0;
}
