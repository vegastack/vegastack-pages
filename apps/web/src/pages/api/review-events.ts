import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  assertWorkspaceActorPermission,
  getApiRequestActor,
  jsonAppError,
  resolvePageAccess,
} from "../../lib/access";
import {
  ensureSeedData,
  pageService,
  reviewEventService,
} from "../../lib/runtime";

export const prerender = false;

function clampLimit(value: string | null) {
  const numeric = Number(value ?? "50");
  return Number.isFinite(numeric) ? Math.min(200, Math.max(1, numeric)) : 50;
}

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    await ensureSeedData();
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
    if (pageId) {
      const page = await pageService.getPage(pageId);
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
    return Response.json({
      events: reviewEventService.list({
        workspaceId,
        pageId: pageId || undefined,
        afterId: url.searchParams.get("after_id"),
        limit: clampLimit(url.searchParams.get("limit")),
      }),
    });
  } catch (error) {
    return jsonAppError(error, "Event listing failed.");
  }
};
