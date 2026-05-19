// Workspace navigation — builds the actor-scoped page/folder tree
// model used by sidebars, command palette, and tree-version envelopes.
// Plan 011 §4 (no legacy singletons): every read goes through the new
// D1-direct services.

import {
  hasPermission,
  type FolderRecord,
  type PageRecord,
} from "@vegastack/pages-core";
import {
  favorites as favoritesService,
  folders as foldersService,
  pages as pagesService,
  type ServiceContext,
} from "@vegastack/pages-services";
import { getDb } from "./runtime";
import {
  resolveActorPermission,
  resolveFolderActorPermission,
  type RequestActor,
} from "./access";

export type WorkspaceNavigationModel = {
  workspaceId: string;
  allPages: PageRecord[];
  allFolders: FolderRecord[];
  visiblePages: PageRecord[];
  visibleFolders: FolderRecord[];
  visiblePageIds: Set<string>;
  visibleFolderIds: Set<string>;
  visiblePageById: Map<string, PageRecord>;
  visibleFolderById: Map<string, FolderRecord>;
  folderById: Map<string, FolderRecord>;
  folderByPath: Map<string, FolderRecord>;
  favoritePageIds: Set<string>;
  favorites: Array<{ pageId: string; userId: string; workspaceId: string }>;
  treeVersion: string;
};

export type WorkspaceNavigationFilter = {
  folderId?: string | null;
  depth?: number | null;
  updatedAfter?: string | null;
};

function readOnlyCtx(actor: RequestActor): ServiceContext {
  return {
    actor: {
      userId: actor.user?.id ?? "",
      email: actor.user?.email ?? null,
      workspaceId: actor.workspaceId ?? null,
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
      emit(`[vpg-navigation] [${level}] ${message}`, fields ?? {});
    },
  };
}

export async function buildWorkspaceNavigation(
  actor: RequestActor,
  workspaceId: string,
): Promise<WorkspaceNavigationModel> {
  const db = await getDb();
  const ctx = readOnlyCtx(actor);
  if (db) ctx.db = db;

  const [allPages, allFolders, favorites] = await Promise.all([
    pagesService.list(ctx, workspaceId),
    foldersService.listAll(ctx, { workspaceId }),
    actor.user
      ? favoritesService.listForWorkspace(ctx, { workspaceId })
      : Promise.resolve(
          [] as Array<{ pageId: string; userId: string; workspaceId: string }>,
        ),
  ]);

  const folderById = new Map(allFolders.map((folder) => [folder.id, folder]));
  const folderByPath = new Map(
    allFolders.map((folder) => [folder.path, folder]),
  );

  let visiblePages: PageRecord[] = [];
  const visibleFolderIds = new Set<string>();
  if (actorCanUseWorkspace(actor, workspaceId)) {
    const pageChecks = await Promise.all(
      allPages.map(async (page) => ({
        page,
        permission: await resolveActorPermission({ actor, page }),
      })),
    );
    visiblePages = pageChecks
      .filter((entry) => hasPermission(entry.permission, "read"))
      .map((entry) => entry.page);

    const folderChecks = await Promise.all(
      allFolders.map(async (folder) => ({
        folder,
        permission: await resolveFolderActorPermission({ actor, folder }),
      })),
    );
    for (const entry of folderChecks) {
      if (hasPermission(entry.permission, "read")) {
        addFolderAncestors(entry.folder, folderById, visibleFolderIds);
      }
    }
    for (const page of visiblePages) {
      if (!page.folderPath) continue;
      // Folders are stored with a leading "/"; page.folderPath does not
      // carry one. Normalize before walking ancestors so the lookups
      // hit the same key shape.
      const normalized = page.folderPath.replace(/^\/+/, "");
      const parts = normalized.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        const key = `/${parts.slice(0, index).join("/")}`;
        const folder = folderByPath.get(key);
        if (folder) visibleFolderIds.add(folder.id);
      }
    }
  }

  const visibleFolders = allFolders.filter((folder) =>
    visibleFolderIds.has(folder.id),
  );
  const visibleFolderById = new Map(
    visibleFolders.map((folder) => [folder.id, folder]),
  );
  const visiblePageIds = new Set(visiblePages.map((page) => page.id));
  const visiblePageById = new Map(visiblePages.map((page) => [page.id, page]));
  const favoritePageIds = new Set(favorites.map((favorite) => favorite.pageId));

  return {
    workspaceId,
    allPages,
    allFolders,
    visiblePages,
    visibleFolders,
    visiblePageIds,
    visibleFolderIds,
    visiblePageById,
    visibleFolderById,
    folderById,
    folderByPath,
    favoritePageIds,
    favorites,
    treeVersion: workspaceTreeVersion({
      workspaceId,
      actorId: actor.user?.id ?? actor.workspaceId ?? "guest",
      pages: visiblePages,
      folders: visibleFolders,
      favoritePageIds,
    }),
  };
}

export function actorCanUseWorkspace(actor: RequestActor, workspaceId: string) {
  return !actor.workspaceId || actor.workspaceId === workspaceId;
}

export function canReadFolderFromNavigation(
  model: WorkspaceNavigationModel,
  folderId: string,
) {
  if (model.visibleFolderIds.has(folderId)) return true;
  const folder = model.folderById.get(folderId);
  if (!folder) return false;
  return model.visiblePages.some(
    (page) =>
      page.folderPath === folder.path ||
      page.folderPath.startsWith(`${folder.path}/`),
  );
}

export function filterWorkspaceNavigation(
  model: WorkspaceNavigationModel,
  filter: WorkspaceNavigationFilter,
) {
  const folderId = filter.folderId?.trim() || null;
  const rootFolder = folderId ? model.visibleFolderById.get(folderId) : null;
  if (folderId && !rootFolder) {
    return null;
  }
  const depth =
    typeof filter.depth === "number" && Number.isFinite(filter.depth)
      ? Math.max(0, Math.floor(filter.depth))
      : null;
  const updatedAfter = filter.updatedAfter || null;
  const rootDepth = rootFolder
    ? rootFolder.path.split("/").filter(Boolean).length
    : 0;

  const folders = model.visibleFolders.filter((folder) => {
    if (updatedAfter && folder.updatedAt <= updatedAfter) return false;
    if (rootFolder) {
      if (folder.id === rootFolder.id) return true;
      if (!folder.path.startsWith(`${rootFolder.path}/`)) return false;
    }
    if (depth === null) return true;
    const folderDepth = folder.path.split("/").filter(Boolean).length;
    return folderDepth - rootDepth <= depth;
  });

  const pages = model.visiblePages.filter((page) => {
    if (updatedAfter && page.updatedAt <= updatedAfter) return false;
    if (!rootFolder) {
      if (depth === null) return true;
      const pageDepth = page.folderPath
        ? page.folderPath.split("/").filter(Boolean).length + 1
        : 1;
      return pageDepth <= depth;
    }
    if (page.folderPath === rootFolder.path) return true;
    if (!page.folderPath?.startsWith(`${rootFolder.path}/`)) return false;
    if (depth === null) return true;
    const pageFolderDepth = page.folderPath.split("/").filter(Boolean).length;
    return pageFolderDepth - rootDepth < depth;
  });

  return { folders, pages, rootFolder };
}

function addFolderAncestors(
  folder: FolderRecord,
  folderById: Map<string, FolderRecord>,
  visibleFolderIds: Set<string>,
) {
  let current: FolderRecord | undefined = folder;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    visibleFolderIds.add(current.id);
    current = current.parentFolderId
      ? folderById.get(current.parentFolderId)
      : undefined;
  }
}

function workspaceTreeVersion(input: {
  workspaceId: string;
  actorId: string;
  pages: PageRecord[];
  folders: FolderRecord[];
  favoritePageIds: Set<string>;
}) {
  const pageStamp = input.pages
    .map(
      (page) =>
        `${page.id}:${page.slugId}:${page.title}:${page.folderPath ?? ""}`,
    )
    .sort()
    .join("|");
  const folderStamp = input.folders
    .map(
      (folder) =>
        `${folder.id}:${folder.slugId}:${folder.name}:${folder.path}:${folder.parentFolderId ?? ""}:${folder.position}`,
    )
    .sort()
    .join("|");
  const favoriteStamp = [...input.favoritePageIds].sort().join(",");
  return hashString(
    `${input.workspaceId}:${input.actorId}:${input.pages.length}:${input.folders.length}:${pageStamp}:${folderStamp}:${favoriteStamp}`,
  );
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `nav_${(hash >>> 0).toString(36)}`;
}
