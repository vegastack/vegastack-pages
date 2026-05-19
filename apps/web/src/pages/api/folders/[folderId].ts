import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  buildEnvelope,
  folders as foldersService,
  jsonWithEnvelope,
  pages as pagesService,
  permissions as permissionsService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  resolveFolderActorPermission,
} from "../../../lib/access";
import {
  removeSearchResource,
  scheduleIndexFolder,
  scheduleIndexPage,
} from "../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../lib/workspace-navigation";

export const prerender = false;

async function assertFolderAdmin(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  url: URL,
  folderId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
  const { ctx } = await buildServiceContext({ cookies, request });
  const folder = await foldersService.get(ctx, folderId);
  if (!folder) {
    throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
  }
  assertApiWorkspaceId({ url, workspaceId: folder.workspaceId });
  const permission = await resolveFolderActorPermission({ actor, folder });
  permissionsService.assertLevel({ actual: permission, required: "write" });
  return { actor, folder };
}

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const folderId = params.folderId ?? "";
    const { actor, folder } = await assertFolderAdmin(
      cookies,
      request,
      url,
      folderId,
    );
    const body = await request.json();
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: folder.workspaceId,
    });
    const updateResult = await workspacesService.updateFolder(ctx, {
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
    const updated = updateResult.data;
    const allPages = await pagesService.list(ctx, folder.workspaceId);
    // page.folderPath is the path without a leading "/"; folder.path keeps
    // the slash. Normalize the previous path for comparison.
    const previousPath = updated.previous.path.replace(/^\/+/, "");
    const newPath = updated.folder.path.replace(/^\/+/, "");
    const affectedPages = allPages.filter(
      (page) =>
        page.folderPath === previousPath ||
        page.folderPath.startsWith(`${previousPath}/`),
    );
    for (const page of affectedPages) {
      const folderPath = `${newPath}${page.folderPath.slice(previousPath.length)}`;
      const moved = await pagesService.move(ctx, {
        pageId: page.id,
        folderPath,
      });
      scheduleIndexPage(moved.data.id);
    }
    scheduleIndexFolder(updated.folder.id);

    await audit.record(ctx, {
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, folder.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      {
        folder: updated.folder,
        updated_pages: affectedPages.length,
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [
          `folder:${updated.folder.id}`,
          ...affectedPages.map((page) => `page:${page.id}`),
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Folder update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const folderId = params.folderId ?? "";
    const { actor, folder } = await assertFolderAdmin(
      cookies,
      request,
      url,
      folderId,
    );
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: folder.workspaceId,
    });
    const allPages = await pagesService.list(ctx, folder.workspaceId);
    const folderPath = folder.path.replace(/^\/+/, "");
    const affectedPages = allPages.filter(
      (page) =>
        page.folderPath === folderPath ||
        page.folderPath.startsWith(`${folderPath}/`),
    );
    for (const page of affectedPages) {
      const moved = await pagesService.move(ctx, {
        pageId: page.id,
        folderPath: "",
      });
      scheduleIndexPage(moved.data.id);
    }
    const allFolders = await foldersService.listAll(ctx, {
      workspaceId: folder.workspaceId,
    });
    const descendants = allFolders
      .filter((candidate) => candidate.path.startsWith(`${folder.path}/`))
      .sort((left, right) => right.path.length - left.path.length);
    for (const descendant of descendants) {
      await workspacesService.deleteFolder(ctx, { folderId: descendant.id });
      await removeSearchResource("folder", descendant.id);
    }
    const deletedResult = await workspacesService.deleteFolder(ctx, {
      folderId,
    });
    const deleted = deletedResult.data;
    await removeSearchResource("folder", deleted.id);
    await audit.record(ctx, {
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, folder.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      {
        folder: deleted,
        moved_pages: affectedPages.length,
        deleted_child_folders: descendants.length,
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [
          `folder:${deleted.id}`,
          ...descendants.map((entry) => `folder:${entry.id}`),
          ...affectedPages.map((page) => `page:${page.id}`),
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Folder delete failed.");
  }
};
