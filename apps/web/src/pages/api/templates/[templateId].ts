import {
  AppError,
  templateBuilderFromMarkdown,
  templateBuilderToMarkdown,
  type TemplateBuilderDocument,
  type TemplateProperty,
} from "@vegastack/pages-core";
import type { APIRoute, AstroCookies } from "astro";
import { buildEnvelope, jsonWithEnvelope } from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
} from "../../../lib/access";
import {
  auditService,
  ensureSeedData,
  permissionService,
  templateService,
  workspaceService,
} from "../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../lib/workspace-navigation";

export const prerender = false;

function serializeTemplate(
  template: ReturnType<typeof templateService.getTemplate>,
) {
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
  permissionService.assert({
    actual: permission,
    required: required === "read" ? "read" : "write",
  });
  return { actor, template };
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
    await ensureSeedData();
    const templateId = params.templateId ?? "";
    const { template } = await assertTemplateAccess(
      cookies,
      request,
      url,
      templateId,
      "read",
    );
    const withSource = await templateService.getTemplateWithSource(template.id);
    if (!withSource) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    return Response.json({
      template: serializeTemplate(withSource.template),
      source: withSource.source,
      builder: templateBuilderFromMarkdown(withSource.source),
    });
  } catch (error) {
    return jsonAppError(error, "Failed to load template.");
  }
};

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const templateId = params.templateId ?? "";
    const { actor, template } = await assertTemplateAccess(
      cookies,
      request,
      url,
      templateId,
      "write",
    );
    const body = await request.json();
    const updated = await templateService.updateTemplate({
      templateId: template.id,
      name: body.name === undefined ? undefined : String(body.name),
      slug: body.slug === undefined ? undefined : String(body.slug),
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
      updatedBy: actor.user?.id ?? null,
    });
    auditService.record({
      workspaceId: updated.template.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "template.updated",
      targetType: "template",
      targetId: updated.template.id,
      metadata: {
        slug: updated.template.slug,
        name: updated.template.name,
      },
    });
    const treeVersion = buildWorkspaceNavigation(
      actor,
      updated.template.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      {
        template: serializeTemplate(updated.template),
        source: updated.source,
        builder: templateBuilderFromMarkdown(updated.source),
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `templates:${updated.template.workspaceId}`,
          `template:${updated.template.id}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Template update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const templateId = params.templateId ?? "";
    const { actor, template } = await assertTemplateAccess(
      cookies,
      request,
      url,
      templateId,
      "write",
    );
    const member = actor.user
      ? workspaceService.getMember(template.workspaceId, actor.user.id)
      : null;
    if (member?.role !== "admin" && actor.user?.role !== "instance_admin") {
      throw new AppError(
        "PERMISSION_DENIED",
        "Only workspace admins can delete templates.",
        403,
      );
    }
    const deleted = await templateService.deleteTemplate(template.id);
    auditService.record({
      workspaceId: deleted.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "template.deleted",
      targetType: "template",
      targetId: deleted.id,
      metadata: { slug: deleted.slug, name: deleted.name },
    });
    const treeVersion = buildWorkspaceNavigation(
      actor,
      deleted.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      { template: serializeTemplate(deleted) },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `templates:${deleted.workspaceId}`,
          `template:${deleted.id}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Template delete failed.");
  }
};
