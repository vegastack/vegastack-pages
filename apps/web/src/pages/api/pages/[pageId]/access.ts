import type { APIRoute } from "astro";
import { jsonAppError } from "../../../../lib/access";
import {
  deleteResourceAccess,
  listResourceAccess,
  setResourceAccess,
  assertResourceAccessAdmin,
} from "../../../../lib/resource-access-api";
import { ensureSeedData, pageService } from "../../../../lib/runtime";

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
    return Response.json({ grant });
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
    return Response.json({ grant });
  } catch (error) {
    return jsonAppError(error, "Page access deletion failed.");
  }
};
