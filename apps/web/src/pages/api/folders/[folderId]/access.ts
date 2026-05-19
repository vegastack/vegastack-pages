import type { APIRoute } from "astro";
import {
  buildEnvelope,
  folders as foldersService,
  jsonWithEnvelope,
} from "@vegastack/pages-services";
import {
  assertResourceAccessAdmin,
  deleteResourceAccess,
  getApiRequestActor,
  listResourceAccess,
  setResourceAccess,
} from "../../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function getResource(
  cookies: Parameters<APIRoute>[0]["cookies"],
  request: Request,
  folderId: string,
) {
  const { ctx } = await buildServiceContext({ cookies, request });
  const folder = await foldersService.get(ctx, folderId);
  if (!folder) return null;
  return { scope: "folder" as const, folder };
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await getResource(cookies, request, params.folderId ?? "");
    if (!resource) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }
    const { actor } = await assertResourceAccessAdmin({
      cookies,
      request,
      resource,
    });
    return Response.json(await listResourceAccess(resource, actor));
  } catch (error) {
    return serviceErrorToResponse(error, "Folder access listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await getResource(cookies, request, params.folderId ?? "");
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, resource.folder.workspaceId)
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
    return serviceErrorToResponse(error, "Folder access update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await getResource(cookies, request, params.folderId ?? "");
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, resource.folder.workspaceId)
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
    return serviceErrorToResponse(error, "Folder access deletion failed.");
  }
};
