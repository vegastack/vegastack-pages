import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  folders as foldersService,
  permissions as permissionsService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  resolveFolderActorPermission,
} from "../../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

async function assertFolderWrite(
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

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const folderId = params.folderId ?? "";
    const { actor, folder } = await assertFolderWrite(
      cookies,
      request,
      url,
      folderId,
    );
    const body = await request.json();
    const direction = String(body.direction ?? "");
    if (direction !== "up" && direction !== "down") {
      throw new AppError(
        "VALIDATION_ERROR",
        "Direction must be up or down.",
        400,
      );
    }
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: folder.workspaceId,
    });
    const result = await workspacesService.reorderFolder(ctx, {
      folderId,
      direction,
    });
    const reordered = result.data;
    await audit.record(ctx, {
      workspaceId: folder.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "folder.reordered",
      targetType: "folder",
      targetId: reordered.folder.id,
      metadata: {
        direction,
        parent_folder_id: reordered.folder.parentFolderId,
        position: reordered.folder.position,
      },
    });
    return Response.json({
      folder: reordered.folder,
      siblings: reordered.siblings,
      envelope: result.envelope,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Folder reorder failed.");
  }
};
