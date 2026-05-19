import { AppError, hasPermission } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  buildEnvelope,
  isServiceError,
  jsonWithEnvelope,
  pages as pagesService,
  reviewEvents,
  templates as templatesService,
} from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
  resolveWorkspaceActorPermission,
} from "../../../../lib/access";
import { scheduleIndexPage } from "../../../../lib/runtime";
import { buildServiceContext } from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const templateId = params.templateId ?? "";
    // First pass: bootstrap without workspaceId so we can resolve the
    // template's workspace, then build the per-workspace ctx.
    const bootstrap = await buildServiceContext({ cookies, request });
    const template = await templatesService.get(bootstrap.ctx, templateId);
    if (!template) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    assertApiWorkspaceId({ url, workspaceId: template.workspaceId });
    const actor = await getApiRequestActor(cookies, request);
    const permission = await resolveWorkspaceActorPermission(
      actor,
      template.workspaceId,
    );
    if (!hasPermission(permission, "write")) {
      throw new AppError("PERMISSION_DENIED", "Insufficient permission.", 403, {
        required: "write",
        actual: permission,
      });
    }

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

    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: template.workspaceId,
    });
    const rendered = await templatesService.render(ctx, {
      templateId: template.id,
      values: { title, ...properties },
    });
    const createResult = await pagesService.create(ctx, {
      workspaceId: template.workspaceId,
      folderPath,
      title: rendered.title,
      sourceType: rendered.sourceType === "mdx" ? "mdx" : "markdown",
      source: rendered.body,
    });
    const created = createResult.data;
    scheduleIndexPage(created.page.id);
    await audit.record(ctx, {
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
    await reviewEvents.emit(ctx, {
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, created.page.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      {
        page_id: created.page.id,
        slug_id: created.page.slugId,
        url: `/p/${created.page.slugId}`,
        version_id: created.page.versionId,
        template_id: template.id,
        template_slug: template.slug,
      },
      buildEnvelope({
        treeVersion,
        contentHash: created.page.contentHash,
        navigationInvalidated: true,
        changedResources: [`page:${created.page.id}`],
      }),
    );
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Page creation from template failed.");
  }
};
