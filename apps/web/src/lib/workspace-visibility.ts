import { hasPermission, type UserRecord } from "@vegastack/pages-core";
import {
  getRequestActor,
  resolveFolderActorPermission,
  resolveActorPermission,
  type RequestActor,
} from "./access";
import { pageService, permissionService, workspaceService } from "./runtime";

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

function actorCanUseWorkspace(actor: RequestActor, workspaceId: string) {
  return !actor.workspaceId || actor.workspaceId === workspaceId;
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
  return pageService
    .listPages(workspaceId)
    .filter(() => actorCanUseWorkspace(actor, workspaceId))
    .filter((page) =>
      hasPermission(resolveActorPermission({ actor, page }), "read"),
    );
}

export function listVisibleFoldersForActor(
  actor: ReturnType<typeof getRequestActor> | RequestActor,
  workspaceId: string,
) {
  if (!actorCanUseWorkspace(actor, workspaceId)) return [];
  const folders = workspaceService.listFolders(workspaceId);
  const folderByPath = new Map(folders.map((folder) => [folder.path, folder]));
  const visibleFolderIds = new Set<string>();

  for (const folder of folders) {
    if (
      hasPermission(resolveFolderActorPermission({ actor, folder }), "read")
    ) {
      for (const ancestor of workspaceService.folderAncestors(folder.id)) {
        visibleFolderIds.add(ancestor.id);
      }
    }
  }

  for (const page of listVisiblePagesForActor(actor, workspaceId)) {
    if (!page.folderPath) continue;
    const parts = page.folderPath.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const folder = folderByPath.get(parts.slice(0, index).join("/"));
      if (folder) visibleFolderIds.add(folder.id);
    }
  }

  return folders.filter((folder) => visibleFolderIds.has(folder.id));
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
  return listVisiblePagesForActor(actor, folder.workspaceId).some(
    (page) =>
      page.folderPath === folder.path ||
      page.folderPath.startsWith(`${folder.path}/`),
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
