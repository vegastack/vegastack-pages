import type { APIRoute } from "astro";
import {
  templateBuilderFromMarkdown,
  templateBuilderToMarkdown,
  type TemplateBuilderDocument,
  type TemplateProperty,
} from "@vegastack/pages-core";
import {
  audit,
  buildEnvelope,
  jsonWithEnvelope,
  permissions as permissionsService,
  templates,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

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
    const workspaceId = params.workspaceId ?? "";
    const actor = await getApiRequestActor(cookies, request);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const member = actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId,
          userId: actor.user.id,
        })
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : await permissionsService.resolve(ctx, {
            workspaceId,
            userId: actor.user?.id ?? "",
            scope: "workspace",
            targetId: workspaceId,
            memberRole: member?.role ?? null,
            instanceRole: actor.user?.role,
          });
    permissionsService.assertLevel({ actual: permission, required: "read" });
    const records = await templates.listForWorkspace(ctx, { workspaceId });
    return Response.json({
      templates: records.map((t) => ({
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
      })),
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Failed to list templates.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    const actor = await getApiRequestActor(cookies, request);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const member = actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId,
          userId: actor.user.id,
        })
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : await permissionsService.resolve(ctx, {
            workspaceId,
            userId: actor.user?.id ?? "",
            scope: "workspace",
            targetId: workspaceId,
            memberRole: member?.role ?? null,
            instanceRole: actor.user?.role,
          });
    permissionsService.assertLevel({ actual: permission, required: "write" });
    const body = await request.json();
    const source = sourceFromBody(body);
    const template = await templates.create(ctx, {
      workspaceId,
      name: String(body.name ?? ""),
      slug: body.slug ? String(body.slug) : "",
      description: body.description ? String(body.description) : "",
      category: body.category ? String(body.category) : "general",
      sourceType: body.source_type === "mdx" ? "mdx" : "markdown",
      source,
      properties: asProperties(body.properties),
    });
    await audit.record(ctx, {
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "template.created",
      targetType: "template",
      targetId: template.id,
      metadata: { slug: template.slug, name: template.name },
    });
    // Templates don't appear in the sidebar tree, but the workspace's
    // template catalog DID change — emit a changed_resources hint so any
    // open template-picker pane refetches.
    const treeVersion = (await buildWorkspaceNavigation(actor, workspaceId))
      .treeVersion;
    return jsonWithEnvelope(
      {
        template: {
          id: template.id,
          slug: template.slug,
          name: template.name,
          description: template.description,
          category: template.category,
          source_type: template.sourceType,
          version_id: template.versionId,
          properties: template.properties,
          is_builtin: template.isBuiltin,
          created_at: template.createdAt,
          updated_at: template.updatedAt,
        },
        source,
        builder: templateBuilderFromMarkdown(source),
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `templates:${workspaceId}`,
          `template:${template.id}`,
        ],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "Template creation failed.");
  }
};
