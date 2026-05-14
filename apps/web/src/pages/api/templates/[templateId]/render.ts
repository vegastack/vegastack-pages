import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
} from "../../../../lib/access";
import {
  ensureSeedData,
  permissionService,
  templateService,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const templateId = params.templateId ?? "";
    const template = templateService.getTemplate(templateId);
    if (!template) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    assertApiWorkspaceId({ url, workspaceId: template.workspaceId });
    const actor = await getApiRequestActor(cookies, request);
    const member = actor.user
      ? workspaceService.getMember(template.workspaceId, actor.user.id)
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== template.workspaceId
        ? "none"
        : permissionService.resolve({
            user: actor.user,
            member,
            workspaceId: template.workspaceId,
          });
    permissionService.assert({ actual: permission, required: "read" });
    const body = await request.json();
    const properties =
      body.properties && typeof body.properties === "object"
        ? (body.properties as Record<string, unknown>)
        : {};
    const rendered = await templateService.render({
      templateId: template.id,
      title: String(body.title ?? "").trim(),
      properties,
    });
    return Response.json({
      template_id: rendered.template.id,
      slug: rendered.template.slug,
      source: rendered.source,
      body: rendered.body,
      frontmatter: rendered.frontmatter,
    });
  } catch (error) {
    return jsonAppError(error, "Template render failed.");
  }
};
