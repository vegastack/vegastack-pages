import type { APIRoute } from "astro";
import { buildEnvelope, jsonWithEnvelope } from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  deletePublication,
  getPublication,
  upsertPublication,
} from "../../../../lib/publication-api";
import { ensureSeedData, workspaceService } from "../../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

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
    const result = await upsertPublication({
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
      result as Record<string, unknown>,
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `publication:folder:${resource.folder.id}`,
          `folder:${resource.folder.id}`,
        ],
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
    const result = await deletePublication({ cookies, request, resource });
    const actor = await getApiRequestActor(cookies, request);
    const treeVersion = buildWorkspaceNavigation(
      actor,
      resource.folder.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      result as Record<string, unknown>,
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `publication:folder:${resource.folder.id}`,
          `folder:${resource.folder.id}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Publication removal failed.");
  }
};
