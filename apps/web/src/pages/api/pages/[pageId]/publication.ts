import type { APIRoute } from "astro";
import { buildEnvelope, attachEnvelope } from "@vegastack/pages-services";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  deletePublication,
  getPublication,
  upsertPublication,
} from "../../../../lib/publication-api";
import { ensureSeedData, pageService } from "../../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function pageResource(pageId: string | undefined) {
  await ensureSeedData();
  const page = pageId ? await pageService.getPage(pageId) : null;
  return page
    ? { type: "page" as const, page: page.page, slugId: page.page.slugId }
    : null;
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await pageResource(params.pageId);
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
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
    const resource = await pageResource(params.pageId);
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
    const treeVersion = buildWorkspaceNavigation(
      actor,
      resource.page.workspaceId,
    ).treeVersion;
    return attachEnvelope(
      Response.json(result),
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
    return jsonAppError(error, "Publication update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    const resource = await pageResource(params.pageId);
    if (!resource) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const result = await deletePublication({ cookies, request, resource });
    const actor = await getApiRequestActor(cookies, request);
    const treeVersion = buildWorkspaceNavigation(
      actor,
      resource.page.workspaceId,
    ).treeVersion;
    return attachEnvelope(
      Response.json(result),
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
    return jsonAppError(error, "Publication removal failed.");
  }
};
