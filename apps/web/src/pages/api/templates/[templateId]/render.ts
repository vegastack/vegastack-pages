import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  permissions as permissionsService,
  templates as templatesService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
} from "../../../../lib/access";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const templateId = params.templateId ?? "";
    const { ctx } = await buildServiceContext({ cookies, request });
    const template = await templatesService.get(ctx, templateId);
    if (!template) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    assertApiWorkspaceId({ url, workspaceId: template.workspaceId });
    const actor = await getApiRequestActor(cookies, request);
    const member = actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId: template.workspaceId,
          userId: actor.user.id,
        })
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== template.workspaceId
        ? "none"
        : await permissionsService.resolve(ctx, {
            workspaceId: template.workspaceId,
            userId: actor.user?.id ?? "",
            scope: "workspace",
            targetId: template.workspaceId,
            memberRole: member?.role ?? null,
            instanceRole: actor.user?.role,
          });
    permissionsService.assertLevel({ actual: permission, required: "read" });
    const body = await request.json();
    const properties =
      body.properties && typeof body.properties === "object"
        ? (body.properties as Record<string, unknown>)
        : {};
    const title = String(body.title ?? "").trim();
    if (!title) {
      throw new AppError("VALIDATION_ERROR", "Page title is required.", 400);
    }
    const rendered = await templatesService.render(ctx, {
      templateId: template.id,
      values: { title, ...properties },
    });
    return Response.json({
      template_id: template.id,
      slug: template.slug,
      source: rendered.body,
      body: rendered.body,
      frontmatter: properties,
    });
  } catch (error) {
    return jsonAppError(error, "Template render failed.");
  }
};
