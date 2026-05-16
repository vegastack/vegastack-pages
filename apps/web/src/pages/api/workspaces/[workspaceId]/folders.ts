import type { APIRoute } from "astro";
import {
  workspaces as workspacesService,
  isServiceError,
} from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  scheduleIndexFolder,
  permissionService,
  workspaceService,
} from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const actor = await getApiRequestActor(cookies, request);
    const workspaceId = params.workspaceId ?? "";
    const member = actor.user
      ? workspaceService.getMember(workspaceId, actor.user.id)
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : permissionService.resolve({
            user: actor.user,
            member,
            workspaceId,
          });
    permissionService.assert({ actual: permission, required: "write" });
    const body = await request.json();
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const result = await workspacesService.createFolder(ctx, {
      workspaceId,
      parentFolderId: body.parent_folder_id
        ? String(body.parent_folder_id)
        : null,
      name: String(body.name ?? ""),
      position: Number.isFinite(body.position)
        ? Number(body.position)
        : undefined,
    });
    const folder = result.data;
    scheduleIndexFolder(folder.id);
    auditService.record({
      workspaceId: folder.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "folder.created",
      targetType: "folder",
      targetId: folder.id,
      metadata: { name: folder.name, parent_folder_id: folder.parentFolderId },
    });
    return Response.json({ folder, envelope: result.envelope });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Folder creation failed.");
  }
};
