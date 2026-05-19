import {
  AppError,
  hasPermission,
  templateBuilderFromMarkdown,
  templateBuilderToMarkdown,
  type TemplateBuilderDocument,
  type TemplateProperty,
} from "@vegastack/pages-core";
import type { APIRoute, AstroCookies } from "astro";
import {
  audit,
  buildEnvelope,
  isServiceError,
  jsonWithEnvelope,
  templates as templatesService,
  type TemplateRecord,
} from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
  resolveWorkspaceActorPermission,
} from "../../../lib/access";
import { buildServiceContext } from "../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../lib/workspace-navigation";

export const prerender = false;

function serializeTemplate(template: TemplateRecord | null | undefined) {
  if (!template) return null;
  return {
    id: template.id,
    workspace_id: template.workspaceId,
    slug: template.slug,
    name: template.name,
    description: template.description,
    category: template.category,
    source_type: template.sourceType,
    version_id: template.versionId,
    content_hash: template.contentHash,
    properties: template.properties,
    is_builtin: template.isBuiltin,
    created_by: template.createdBy,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  };
}

async function assertTemplateAccess(
  cookies: AstroCookies,
  request: Request,
  url: URL,
  templateId: string,
  required: "read" | "write",
) {
  // Bootstrap a ctx WITHOUT workspaceId so we can look up the template
  // (which provides workspace scope), then rebuild for the mutation.
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
  if (!hasPermission(permission, required === "read" ? "read" : "write")) {
    throw new AppError("PERMISSION_DENIED", "Insufficient permission.", 403, {
      required,
      actual: permission,
    });
  }
  const { ctx } = await buildServiceContext({
    cookies,
    request,
    workspaceId: template.workspaceId,
  });
  return { actor, template, ctx };
}

function asProperties(input: unknown): TemplateProperty[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return [];
  return input as TemplateProperty[];
}

function sourceFromBody(body: Record<string, unknown>): string | undefined {
  if (body.builder !== undefined) {
    return templateBuilderToMarkdown(body.builder as TemplateBuilderDocument);
  }
  if (body.source !== undefined) return String(body.source);
  return undefined;
}

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const templateId = params.templateId ?? "";
    const { template, ctx } = await assertTemplateAccess(
      cookies,
      request,
      url,
      templateId,
      "read",
    );
    const withSource = await templatesService.getWithSource(ctx, template.id);
    if (!withSource) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    return Response.json({
      template: serializeTemplate(withSource),
      source: withSource.source,
      builder: templateBuilderFromMarkdown(withSource.source),
    });
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Failed to load template.");
  }
};

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const templateId = params.templateId ?? "";
    const { actor, template, ctx } = await assertTemplateAccess(
      cookies,
      request,
      url,
      templateId,
      "write",
    );
    const body = await request.json();
    const updated = await templatesService.update(ctx, template.id, {
      name: body.name === undefined ? undefined : String(body.name),
      description:
        body.description === undefined ? undefined : String(body.description),
      category: body.category === undefined ? undefined : String(body.category),
      sourceType:
        body.source_type === undefined
          ? undefined
          : body.source_type === "mdx"
            ? "mdx"
            : "markdown",
      source: sourceFromBody(body),
      properties: asProperties(body.properties),
    });
    // Re-read with source so the response can include the canonical
    // post-update body and builder doc.
    const withSource = await templatesService.getWithSource(ctx, updated.id);
    const source = withSource?.source ?? "";
    await audit.record(ctx, {
      workspaceId: updated.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "template.updated",
      targetType: "template",
      targetId: updated.id,
      metadata: {
        slug: updated.slug,
        name: updated.name,
      },
    });
    const treeVersion = (
      await buildWorkspaceNavigation(actor, updated.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      {
        template: serializeTemplate(updated),
        source,
        builder: templateBuilderFromMarkdown(source),
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `templates:${updated.workspaceId}`,
          `template:${updated.id}`,
        ],
      }),
    );
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Template update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const templateId = params.templateId ?? "";
    const { actor, template, ctx } = await assertTemplateAccess(
      cookies,
      request,
      url,
      templateId,
      "write",
    );
    // Workspace-admin (or instance-admin) only — mirrors legacy guard.
    const adminPermission = await resolveWorkspaceActorPermission(
      actor,
      template.workspaceId,
    );
    if (
      !hasPermission(adminPermission, "admin") &&
      actor.user?.role !== "instance_admin"
    ) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Only workspace admins can delete templates.",
        403,
      );
    }
    await templatesService.remove(ctx, template.id);
    await audit.record(ctx, {
      workspaceId: template.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "template.deleted",
      targetType: "template",
      targetId: template.id,
      metadata: { slug: template.slug, name: template.name },
    });
    const treeVersion = (
      await buildWorkspaceNavigation(actor, template.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      { template: serializeTemplate(template) },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `templates:${template.workspaceId}`,
          `template:${template.id}`,
        ],
      }),
    );
  } catch (error) {
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Template delete failed.");
  }
};
