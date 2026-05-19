// Workspace visibility helpers — actor-scoped queries for "what can
// this user see in this workspace?" Plan 011 §4. All async + D1-direct
// via @vegastack/pages-services.

import { hasPermission, type UserRecord } from "@vegastack/pages-core";
import { resolveFolderActorPermission, type RequestActor } from "./access";
import { getDb } from "./runtime";
import {
  folders as foldersService,
  permissions as permissionsService,
  workspaces as workspacesService,
  type ServiceContext,
} from "@vegastack/pages-services";
import {
  actorCanUseWorkspace,
  buildWorkspaceNavigation,
  canReadFolderFromNavigation,
} from "./workspace-navigation";

function readOnlyCtx(user: UserRecord | null): ServiceContext {
  return {
    actor: {
      userId: user?.id ?? "",
      email: user?.email ?? null,
      workspaceId: null,
    },
    async computeTreeVersion() {
      return "";
    },
    waitUntil(promise) {
      void promise.catch(() => undefined);
    },
    log(level, message, fields) {
      const emit =
        level === "error" || level === "warn" ? console.error : console.log;
      emit(`[vpg-visibility] [${level}] ${message}`, fields ?? {});
    },
  };
}

export async function resolveWorkspacePermission(
  user: UserRecord | null,
  workspaceId: string,
) {
  const db = await getDb();
  const ctx = readOnlyCtx(user);
  if (db) ctx.db = db;
  const member = user
    ? await workspacesService.getMember(ctx, {
        workspaceId,
        userId: user.id,
      })
    : null;
  return permissionsService.resolve(ctx, {
    workspaceId,
    userId: user?.id ?? "",
    scope: "workspace",
    targetId: workspaceId,
    memberRole: member?.role ?? null,
    instanceRole: user?.role,
  });
}

export async function listSelectableWorkspaces(user: UserRecord | null) {
  if (!user) return [];
  const db = await getDb();
  const ctx = readOnlyCtx(user);
  if (db) ctx.db = db;
  const workspaces = await workspacesService.listForUser(ctx, {
    userId: user.id,
  });
  const visible: typeof workspaces = [];
  for (const workspace of workspaces) {
    const permission = await resolveWorkspacePermission(user, workspace.id);
    if (hasPermission(permission, "read")) visible.push(workspace);
  }
  return visible;
}

export async function listVisiblePagesForActor(
  actor: RequestActor,
  workspaceId: string,
) {
  const nav = await buildWorkspaceNavigation(actor, workspaceId);
  return nav.visiblePages;
}

export async function listVisibleFoldersForActor(
  actor: RequestActor,
  workspaceId: string,
) {
  const nav = await buildWorkspaceNavigation(actor, workspaceId);
  return nav.visibleFolders;
}

export async function canReadFolderOrVisibleDescendants(
  actor: RequestActor,
  folderId: string,
) {
  const db = await getDb();
  const ctx = readOnlyCtx(actor.user);
  if (db) ctx.db = db;
  const folder = await foldersService.get(ctx, folderId);
  if (!folder) return false;
  if (!actorCanUseWorkspace(actor, folder.workspaceId)) return false;
  if (
    hasPermission(await resolveFolderActorPermission({ actor, folder }), "read")
  ) {
    return true;
  }
  return canReadFolderFromNavigation(
    await buildWorkspaceNavigation(actor, folder.workspaceId),
    folderId,
  );
}

export async function canReadWorkspaceOrScopedPages(
  actor: RequestActor,
  workspaceId: string,
) {
  if (!actorCanUseWorkspace(actor, workspaceId)) return false;
  if (!actor.user) return false;
  if (
    hasPermission(
      await resolveWorkspacePermission(actor.user, workspaceId),
      "read",
    )
  ) {
    return true;
  }
  return (await listVisiblePagesForActor(actor, workspaceId)).length > 0;
}
