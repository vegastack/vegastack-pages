import type { APIRoute } from "astro";
import { buildEnvelope, jsonWithEnvelope } from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  assertResourceAccessAdmin,
  deleteResourceAccess,
  listResourceAccess,
  setResourceAccess,
} from "../../../../lib/resource-access-api";
import { ensureSeedData, workspaceService } from "../../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

function getResource(folderId: string) {
  const folder = workspaceService.getFolder(folderId);
  if (!folder) return null;
  return { scope: "folder" as const, folder };
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const resource = getResource(params.folderId ?? "");
    if (!resource) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }
    await assertResourceAccessAdmin({ cookies, request, resource });
    return Response.json(listResourceAccess(resource));
  } catch (error) {
    return jsonAppError(error, "Folder access listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const resource = getResource(params.folderId ?? "");
    if (!resource) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }
    const grant = await setResourceAccess({
      cookies,
      request,
      resource,
      body: await request.json(),
    });
    const actor = await getApiRequestActor(cookies, request);
    const treeVersion = buildWorkspaceNavigation(
      actor,
      resource.folder.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      { grant },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [
          `permission:folder:${resource.folder.id}`,
          `folder:${resource.folder.id}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Folder access update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const resource = getResource(params.folderId ?? "");
    if (!resource) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }
    const body = await request.json();
    const grant = await deleteResourceAccess({
      cookies,
      request,
      resource,
      grantId: String(body.grant_id ?? ""),
    });
    const actor = await getApiRequestActor(cookies, request);
    const treeVersion = buildWorkspaceNavigation(
      actor,
      resource.folder.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      { grant },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [
          `permission:folder:${resource.folder.id}`,
          `folder:${resource.folder.id}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Folder access deletion failed.");
  }
};
