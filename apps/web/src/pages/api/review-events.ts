import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { pages as pagesService, reviewEvents } from "@vegastack/pages-services";
import {
  assertWorkspaceActorPermission,
  getApiRequestActor,
  resolvePageAccess,
} from "../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../lib/service-context";

export const prerender = false;

function clampLimit(value: string | null) {
  const numeric = Number(value ?? "50");
  return Number.isFinite(numeric) ? Math.min(200, Math.max(1, numeric)) : 50;
}

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    const actor = await getApiRequestActor(cookies, request);
    const workspaceId = url.searchParams.get("workspace_id")?.trim() || "";
    const pageId = url.searchParams.get("page_id")?.trim() || "";
    if (!workspaceId) {
      throw new AppError(
        "WORKSPACE_REQUIRED",
        "workspace_id is required for this API request.",
        400,
        {
          parameter: "workspace_id",
          location: "query",
          hint: "Pass workspace_id with review event requests. Add page_id to narrow to one page.",
        },
      );
    }
    assertWorkspaceActorPermission({
      actor,
      workspaceId,
      required: "read",
    });
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    if (pageId) {
      const page = await pagesService.get(ctx, pageId);
      if (!page) {
        throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
      }
      if (page.page.workspaceId !== workspaceId) {
        throw new AppError(
          "PERMISSION_DENIED",
          "workspace_id does not match this page.",
          403,
          {
            parameter: "workspace_id",
            location: "query",
            received_workspace_id: workspaceId,
          },
        );
      }
      await resolvePageAccess({
        cookies,
        request,
        url,
        page: page.page,
        required: "read",
      });
    }
    const events = await reviewEvents.list(ctx, {
      workspaceId,
      pageId: pageId || undefined,
      limit: clampLimit(url.searchParams.get("limit")),
    });
    return Response.json({ events });
  } catch (error) {
    return serviceErrorToResponse(error, "Event listing failed.");
  }
};
