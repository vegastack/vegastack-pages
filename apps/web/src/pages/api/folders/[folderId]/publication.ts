import type { APIRoute } from "astro";
import {
  buildEnvelope,
  folders as foldersService,
  jsonWithEnvelope,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import {
  deletePublication,
  getPublication,
  upsertPublication,
} from "../../../../lib/publication-api";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function folderResource(
  cookies: Parameters<APIRoute>[0]["cookies"],
  request: Request,
  folderId: string | undefined,
) {
  if (!folderId) return null;
  const { ctx } = await buildServiceContext({ cookies, request });
  const folder = await foldersService.get(ctx, folderId);
  return folder
    ? { type: "folder" as const, folder, slugId: folder.slugId }
    : null;
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await folderResource(cookies, request, params.folderId);
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
    return serviceErrorToResponse(error, "Publication lookup failed.");
  }
};

export const PUT: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await folderResource(cookies, request, params.folderId);
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, resource.folder.workspaceId)
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
    return serviceErrorToResponse(error, "Publication update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await folderResource(cookies, request, params.folderId);
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, resource.folder.workspaceId)
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
    return serviceErrorToResponse(error, "Publication removal failed.");
  }
};
