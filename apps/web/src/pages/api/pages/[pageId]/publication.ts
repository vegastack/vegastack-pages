import type { APIRoute } from "astro";
import {
  buildEnvelope,
  jsonWithEnvelope,
  pages as pagesService,
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

async function pageResource(
  cookies: Parameters<typeof getApiRequestActor>[0],
  request: Request,
  pageId: string | undefined,
) {
  const { ctx } = await buildServiceContext({ cookies, request });
  const page = pageId ? await pagesService.get(ctx, pageId) : null;
  return page
    ? { type: "page" as const, page: page.page, slugId: page.page.slugId }
    : null;
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await pageResource(cookies, request, params.pageId);
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
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
    const resource = await pageResource(cookies, request, params.pageId);
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
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
      await buildWorkspaceNavigation(actor, resource.page.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      result as Record<string, unknown>,
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `publication:page:${resource.page.id}`,
          `page:${resource.page.id}`,
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Publication update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await pageResource(cookies, request, params.pageId);
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const result = await deletePublication({ cookies, request, resource });
    const actor = await getApiRequestActor(cookies, request);
    const treeVersion = (
      await buildWorkspaceNavigation(actor, resource.page.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      result as Record<string, unknown>,
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `publication:page:${resource.page.id}`,
          `page:${resource.page.id}`,
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Publication removal failed.");
  }
};
