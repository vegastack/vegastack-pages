import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
  resolveFolderActorPermission,
} from "../../../lib/access";
import {
  auditService,
  ensureSeedData,
  indexFolder,
  indexPage,
  pageService,
  permissionService,
  removeSearchResource,
  workspaceService,
} from "../../../lib/runtime";

export const prerender = false;

async function assertFolderAdmin(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  url: URL,
  folderId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
  const folder = workspaceService.getFolder(folderId);
  if (!folder) {
    throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
  }
  assertApiWorkspaceId({ url, workspaceId: folder.workspaceId });
  const permission = resolveFolderActorPermission({ actor, folder });
  permissionService.assert({ actual: permission, required: "write" });
  return { actor, folder };
}

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const folderId = params.folderId ?? "";
    const { actor, folder } = await assertFolderAdmin(
      cookies,
      request,
      url,
      folderId,
    );
    const body = await request.json();
    const updated = workspaceService.updateFolder({
      folderId,
      name: body.name === undefined ? undefined : String(body.name),
      parentFolderId:
        body.parent_folder_id === undefined
          ? undefined
          : body.parent_folder_id
            ? String(body.parent_folder_id)
            : null,
      position: Number.isFinite(Number(body.position))
        ? Number(body.position)
        : undefined,
    });

    const affectedPages = pageService
      .listPages(folder.workspaceId)
      .filter(
        (page) =>
          page.folderPath === updated.previous.path ||
          page.folderPath.startsWith(`${updated.previous.path}/`),
      );
    for (const page of affectedPages) {
      const folderPath = `${updated.folder.path}${page.folderPath.slice(updated.previous.path.length)}`;
      const moved = pageService.movePage({ pageId: page.id, folderPath });
      await indexPage(moved.id);
    }
    await indexFolder(updated.folder.id);

    auditService.record({
      workspaceId: folder.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "folder.updated",
      targetType: "folder",
      targetId: updated.folder.id,
      metadata: {
        previous_path: updated.previous.path,
        path: updated.folder.path,
      },
    });
    return Response.json({
      folder: updated.folder,
      updated_pages: affectedPages.length,
    });
  } catch (error) {
    return jsonAppError(error, "Folder update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const folderId = params.folderId ?? "";
    const { actor, folder } = await assertFolderAdmin(
      cookies,
      request,
      url,
      folderId,
    );
    const affectedPages = pageService
      .listPages(folder.workspaceId)
      .filter(
        (page) =>
          page.folderPath === folder.path ||
          page.folderPath.startsWith(`${folder.path}/`),
      );
    for (const page of affectedPages) {
      const moved = pageService.movePage({ pageId: page.id, folderPath: "" });
      await indexPage(moved.id);
    }
    const descendants = workspaceService
      .listFolders(folder.workspaceId)
      .filter((candidate) => candidate.path.startsWith(`${folder.path}/`))
      .sort((left, right) => right.path.length - left.path.length);
    for (const descendant of descendants) {
      workspaceService.deleteFolder(descendant.id);
      await removeSearchResource("folder", descendant.id);
    }
    const deleted = workspaceService.deleteFolder(folderId);
    await removeSearchResource("folder", deleted.id);
    auditService.record({
      workspaceId: deleted.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "folder.deleted",
      targetType: "folder",
      targetId: deleted.id,
      metadata: {
        path: deleted.path,
        moved_pages: affectedPages.length,
        deleted_child_folders: descendants.length,
      },
    });
    return Response.json({
      folder: deleted,
      moved_pages: affectedPages.length,
      deleted_child_folders: descendants.length,
    });
  } catch (error) {
    return jsonAppError(error, "Folder delete failed.");
  }
};
