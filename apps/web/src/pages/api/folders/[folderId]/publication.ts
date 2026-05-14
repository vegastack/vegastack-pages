import type { APIRoute } from "astro";
import { jsonAppError } from "../../../../lib/access";
import {
  deletePublication,
  getPublication,
  upsertPublication,
} from "../../../../lib/publication-api";
import { ensureSeedData, workspaceService } from "../../../../lib/runtime";

export const prerender = false;

async function folderResource(folderId: string | undefined) {
  await ensureSeedData();
  const folder = folderId ? workspaceService.getFolder(folderId) : null;
  return folder
    ? { type: "folder" as const, folder, slugId: folder.slugId }
    : null;
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await folderResource(params.folderId);
    if (!resource) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }
    return Response.json(await getPublication({ cookies, request, resource }));
  } catch (error) {
    return jsonAppError(error, "Publication lookup failed.");
  }
};

export const PUT: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await folderResource(params.folderId);
    if (!resource) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }
    return Response.json(
      await upsertPublication({
        cookies,
        request,
        resource,
        body: await request.json(),
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Publication update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await folderResource(params.folderId);
    if (!resource) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }
    return Response.json(
      await deletePublication({ cookies, request, resource }),
    );
  } catch (error) {
    return jsonAppError(error, "Publication removal failed.");
  }
};
