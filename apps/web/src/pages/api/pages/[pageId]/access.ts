import type { APIRoute } from "astro";
import {
  buildEnvelope,
  jsonWithEnvelope,
  pages as pagesService,
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
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  pageId: string,
) {
  const { ctx } = await buildServiceContext({ cookies, request });
  const page = await pagesService.get(ctx, pageId);
  if (!page) {
    return null;
  }
  return { scope: "page" as const, page: page.page };
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await getResource(cookies, request, params.pageId ?? "");
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
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
    return serviceErrorToResponse(error, "Page access listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await getResource(cookies, request, params.pageId ?? "");
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
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
      await buildWorkspaceNavigation(actor, resource.page.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      { grant },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [
          `permission:page:${resource.page.id}`,
          `page:${resource.page.id}`,
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Page access update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await getResource(cookies, request, params.pageId ?? "");
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
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
      await buildWorkspaceNavigation(actor, resource.page.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      { grant },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [
          `permission:page:${resource.page.id}`,
          `page:${resource.page.id}`,
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Page access deletion failed.");
  }
};
