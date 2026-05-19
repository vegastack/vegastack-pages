import {
  templateBuilderFromMarkdown,
  templateBuilderToMarkdown,
} from "@vegastack/pages-core";
import { audit, templates } from "@vegastack/pages-services";
import { asString, optionalString, requiredWorkspaceId } from "../util";
import { assertWorkspacePermission } from "../permissions";
import {
  asTemplateBuilder,
  asTemplateProperties,
  resolveTemplate,
  serializeMcpTemplate,
  slugifyName,
} from "../shared";
import type { McpToolContext } from "../types";

export async function createTemplate(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "write");
  const source = templateBuilderToMarkdown(asTemplateBuilder(args.builder));
  const slug =
    optionalString(args.slug) ?? slugifyName(asString(args.name, "template"));
  const created = await templates.create(ctx, {
    workspaceId,
    name: asString(args.name),
    slug,
    description: optionalString(args.description) ?? "",
    category: optionalString(args.category) ?? "general",
    sourceType: args.source_type === "mdx" ? "mdx" : "markdown",
    source,
    properties: asTemplateProperties(args.properties),
  });
  await audit.record(ctx, {
    workspaceId,
    actorUserId: context.actor.user?.id ?? null,
    action: "template.created",
    targetType: "template",
    targetId: created.id,
    metadata: {
      slug: created.slug,
      name: created.name,
      source: "mcp",
    },
  });
  return {
    template: serializeMcpTemplate(created),
    source,
    builder: templateBuilderFromMarkdown(source),
  };
}

export async function updateTemplate(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "write");
  const template = await resolveTemplate(
    context,
    workspaceId,
    asString(args.template),
  );
  const source =
    args.builder === undefined
      ? undefined
      : templateBuilderToMarkdown(asTemplateBuilder(args.builder));
  const updated = await templates.update(ctx, template.id, {
    name: optionalString(args.name),
    description: optionalString(args.description),
    category: optionalString(args.category),
    sourceType:
      args.source_type === undefined
        ? undefined
        : args.source_type === "mdx"
          ? "mdx"
          : "markdown",
    source,
    properties: asTemplateProperties(args.properties),
  });
  await audit.record(ctx, {
    workspaceId: updated.workspaceId,
    actorUserId: context.actor.user?.id ?? null,
    action: "template.updated",
    targetType: "template",
    targetId: updated.id,
    metadata: {
      slug: updated.slug,
      name: updated.name,
      source: "mcp",
    },
  });
  const finalSource =
    source ?? (await templates.getWithSource(ctx, updated.id))?.source ?? "";
  return {
    template: serializeMcpTemplate(updated),
    source: finalSource,
    builder: templateBuilderFromMarkdown(finalSource),
  };
}

export async function renderTemplate(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "read");
  const template = await resolveTemplate(
    context,
    workspaceId,
    asString(args.template),
  );
  const properties =
    args.properties && typeof args.properties === "object"
      ? (args.properties as Record<string, unknown>)
      : {};
  const values = {
    title: asString(args.title),
    ...properties,
  };
  const rendered = await templates.render(ctx, {
    templateId: template.id,
    values,
  });
  return {
    template_id: template.id,
    slug: template.slug,
    source: rendered.body,
    body: rendered.body,
    frontmatter: properties,
  };
}
