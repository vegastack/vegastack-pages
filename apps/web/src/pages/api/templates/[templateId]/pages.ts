import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
} from "../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  scheduleIndexPage,
  pageService,
  permissionService,
  reviewEventService,
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
    permissionService.assert({ actual: permission, required: "write" });

    const body = await request.json();
    const title = String(body.title ?? "").trim();
    if (!title) {
      throw new AppError("VALIDATION_ERROR", "Page title is required.", 400);
    }
    const folderPath =
      typeof body.folder_path === "string" ? body.folder_path : "";
    const properties =
      body.properties && typeof body.properties === "object"
        ? (body.properties as Record<string, unknown>)
        : {};

    const rendered = await templateService.render({
      templateId: template.id,
      title,
      properties,
    });
    const created = await pageService.createPage({
      workspaceId: template.workspaceId,
      folderPath,
      title,
      sourceType: rendered.template.sourceType === "mdx" ? "mdx" : "markdown",
      source: rendered.source,
    });
    scheduleIndexPage(created.page.id);
    auditService.record({
      workspaceId: created.page.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "page.created_from_template",
      targetType: "page",
      targetId: created.page.id,
      metadata: {
        template_id: template.id,
        template_slug: template.slug,
        title: created.page.title,
        folder_path: created.page.folderPath,
      },
    });
    reviewEventService.emit({
      workspaceId: created.page.workspaceId,
      pageId: created.page.id,
      type: "page.created",
      actorUserId: actor.user?.id ?? null,
      payload: {
        title: created.page.title,
        slug_id: created.page.slugId,
        template_slug: template.slug,
      },
    });
    return Response.json({
      page_id: created.page.id,
      slug_id: created.page.slugId,
      url: `/p/${created.page.slugId}`,
      version_id: created.page.versionId,
      template_id: template.id,
      template_slug: template.slug,
    });
  } catch (error) {
    return jsonAppError(error, "Page creation from template failed.");
  }
};
