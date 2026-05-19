import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { pages as pagesService } from "@vegastack/pages-services";
import {
  assertWorkspaceActorPermission,
  getApiRequestActor,
  resolvePageAccess,
} from "../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../lib/service-context";
import {
  validateEditableSource,
  type EditableSourceType,
} from "../../lib/source-validation";

export const prerender = false;

function coerceSourceType(value: unknown, fallback: EditableSourceType) {
  return value === "mdx" || value === "html" || value === "markdown"
    ? value
    : fallback;
}

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    const body = await request.json();
    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Authentication is required.", 401);
    }

    const pageId = body.page_id ? String(body.page_id) : "";
    const workspaceId = body.workspace_id ? String(body.workspace_id) : null;
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const page = pageId ? await pagesService.get(ctx, pageId) : null;
    if (pageId && !page) {
      throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    }
    if (page) {
      await resolvePageAccess({
        cookies,
        request,
        url,
        page: page.page,
        required: "read",
      });
    } else if (workspaceId) {
      assertWorkspaceActorPermission({
        actor,
        workspaceId,
        required: "read",
      });
    } else {
      throw new AppError(
        "WORKSPACE_REQUIRED",
        "workspace_id is required when validating source without page_id.",
        400,
        {
          parameter: "workspace_id",
          location: "body",
          hint: "Pass page_id for stored page validation, or workspace_id for standalone source validation.",
        },
      );
    }

    const source =
      body.source === undefined ? (page?.source ?? "") : String(body.source);
    const sourceType = coerceSourceType(
      body.source_type,
      page?.page.sourceType ?? "markdown",
    );
    return Response.json(await validateEditableSource({ source, sourceType }));
  } catch (error) {
    return serviceErrorToResponse(error, "Source validation failed.");
  }
};
