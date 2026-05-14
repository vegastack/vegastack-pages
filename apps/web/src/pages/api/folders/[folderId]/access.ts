import type { APIRoute } from "astro";
import { jsonAppError } from "../../../../lib/access";
import {
  assertResourceAccessAdmin,
  deleteResourceAccess,
  listResourceAccess,
  setResourceAccess,
} from "../../../../lib/resource-access-api";
import { ensureSeedData, workspaceService } from "../../../../lib/runtime";

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
    return Response.json({ grant });
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
    return Response.json({ grant });
  } catch (error) {
    return jsonAppError(error, "Folder access deletion failed.");
  }
};
