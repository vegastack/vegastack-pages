import type { APIRoute } from "astro";
import {
  audit,
  permissions as permissionsService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import { scheduleIndexFolder } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    const actor = await getApiRequestActor(cookies, request);
    const workspaceId = params.workspaceId ?? "";
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const member = actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId,
          userId: actor.user.id,
        })
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : await permissionsService.resolve(ctx, {
            workspaceId,
            userId: actor.user?.id ?? "",
            scope: "workspace",
            targetId: workspaceId,
            memberRole: member?.role ?? null,
            instanceRole: actor.user?.role,
          });
    permissionsService.assertLevel({ actual: permission, required: "write" });
    const body = await request.json();
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
    await audit.record(ctx, {
      workspaceId: folder.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "folder.created",
      targetType: "folder",
      targetId: folder.id,
      metadata: { name: folder.name, parent_folder_id: folder.parentFolderId },
    });
    return Response.json({ folder, envelope: result.envelope });
  } catch (error) {
    return serviceErrorToResponse(error, "Folder creation failed.");
  }
};
