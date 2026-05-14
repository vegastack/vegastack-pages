import type { APIRoute } from "astro";
import {
  templateBuilderFromMarkdown,
  templateBuilderToMarkdown,
  type TemplateBuilderDocument,
  type TemplateProperty,
} from "@vegastack/pages-core";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  auditService,
  ensureSeedData,
  permissionService,
  templateService,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

function asProperties(input: unknown): TemplateProperty[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return [];
  return input as TemplateProperty[];
}

function sourceFromBody(body: Record<string, unknown>): string {
  if (body.builder !== undefined) {
    return templateBuilderToMarkdown(body.builder as TemplateBuilderDocument);
  }
  return String(body.source ?? "");
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await getApiRequestActor(cookies, request);
    const member = actor.user
      ? workspaceService.getMember(workspaceId, actor.user.id)
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : permissionService.resolve({
            user: actor.user,
            member,
            workspaceId,
          });
    permissionService.assert({ actual: permission, required: "read" });
    const templates = templateService.listTemplates(workspaceId).map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      source_type: t.sourceType,
      version_id: t.versionId,
      properties: t.properties,
      is_builtin: t.isBuiltin,
      created_by: t.createdBy,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    }));
    return Response.json({ templates });
  } catch (error) {
    return jsonAppError(error, "Failed to list templates.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await getApiRequestActor(cookies, request);
    const member = actor.user
      ? workspaceService.getMember(workspaceId, actor.user.id)
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : permissionService.resolve({
            user: actor.user,
            member,
            workspaceId,
          });
    permissionService.assert({ actual: permission, required: "write" });
    const body = await request.json();
    const created = await templateService.createTemplate({
      workspaceId,
      name: String(body.name ?? ""),
      slug: body.slug ? String(body.slug) : undefined,
      description: body.description ? String(body.description) : "",
      category: body.category ? String(body.category) : "general",
      sourceType: body.source_type === "mdx" ? "mdx" : "markdown",
      source: sourceFromBody(body),
      properties: asProperties(body.properties),
      createdBy: actor.user?.id ?? null,
    });
    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "template.created",
      targetType: "template",
      targetId: created.template.id,
      metadata: { slug: created.template.slug, name: created.template.name },
    });
    return Response.json({
      template: {
        id: created.template.id,
        slug: created.template.slug,
        name: created.template.name,
        description: created.template.description,
        category: created.template.category,
        source_type: created.template.sourceType,
        version_id: created.template.versionId,
        properties: created.template.properties,
        is_builtin: created.template.isBuiltin,
        created_at: created.template.createdAt,
        updated_at: created.template.updatedAt,
      },
      source: created.source,
      builder: templateBuilderFromMarkdown(created.source),
    });
  } catch (error) {
    return jsonAppError(error, "Template creation failed.");
  }
};
