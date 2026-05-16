import type { APIRoute } from "astro";
import { buildEnvelope, jsonWithEnvelope } from "@vegastack/pages-services";
import {
  assertResourceAccessAdmin,
  deleteResourceAccess,
  getApiRequestActor,
  jsonAppError,
  listResourceAccess,
  setResourceAccess,
} from "../../../../lib/access";
import { ensureSeedData, pageService } from "../../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function getResource(pageId: string) {
  const page = await pageService.getPage(pageId);
  if (!page) {
    return null;
  }
  return { scope: "page" as const, page: page.page };
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const resource = await getResource(params.pageId ?? "");
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    await assertResourceAccessAdmin({ cookies, request, resource });
    return Response.json(listResourceAccess(resource));
  } catch (error) {
    return jsonAppError(error, "Page access listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const resource = await getResource(params.pageId ?? "");
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
    const treeVersion = buildWorkspaceNavigation(
      actor,
      resource.page.workspaceId,
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
    return jsonAppError(error, "Page access update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const resource = await getResource(params.pageId ?? "");
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
    const treeVersion = buildWorkspaceNavigation(
      actor,
      resource.page.workspaceId,
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
    return jsonAppError(error, "Page access deletion failed.");
  }
};
