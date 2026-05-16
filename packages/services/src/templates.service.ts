// TemplatesService — page templates within a workspace.

import type { ServiceContext, MutationEnvelope } from "./context.ts";
import type {
  TemplateRecord,
  TemplateWithSource,
  CreateTemplateInput,
  UpdateTemplateInput,
  RenderTemplateInput,
} from "./repo/template.repo.ts";
import type { PageWithSource } from "./repo/page.repo.ts";
import { ServiceError } from "./errors.ts";
import { buildEnvelope } from "./envelope.ts";

export type TemplateMutation<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

export async function list(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<TemplateRecord[]> {
  return ctx.repo.templates.list(input.workspaceId);
}

export async function get(
  ctx: ServiceContext,
  input: { templateId: string },
): Promise<TemplateRecord> {
  const template = await ctx.repo.templates.get(input.templateId);
  if (!template) {
    throw new ServiceError("NOT_FOUND", "Template was not found.");
  }
  return template;
}

export async function getWithSource(
  ctx: ServiceContext,
  input: { templateId: string },
): Promise<TemplateWithSource> {
  const result = await ctx.repo.templates.getWithSource(input.templateId);
  if (!result) {
    throw new ServiceError("NOT_FOUND", "Template was not found.");
  }
  return result;
}

export async function create(
  ctx: ServiceContext,
  input: CreateTemplateInput,
): Promise<TemplateMutation<TemplateWithSource>> {
  const result = await ctx.repo.templates.create(input);
  const treeVersion = await ctx.computeTreeVersion(result.template.workspaceId);
  return {
    data: result,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `templates:${result.template.workspaceId}`,
        `template:${result.template.id}`,
      ],
    }),
  };
}

export async function update(
  ctx: ServiceContext,
  input: UpdateTemplateInput,
): Promise<TemplateMutation<TemplateWithSource>> {
  const result = await ctx.repo.templates.update(input);
  const treeVersion = await ctx.computeTreeVersion(result.template.workspaceId);
  return {
    data: result,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `templates:${result.template.workspaceId}`,
        `template:${result.template.id}`,
      ],
    }),
  };
}

export async function remove(
  ctx: ServiceContext,
  input: { templateId: string },
): Promise<TemplateMutation<TemplateRecord>> {
  const deleted = await ctx.repo.templates.delete(input.templateId);
  const treeVersion = await ctx.computeTreeVersion(deleted.workspaceId);
  return {
    data: deleted,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `templates:${deleted.workspaceId}`,
        `template:${deleted.id}`,
      ],
    }),
  };
}

export async function render(
  ctx: ServiceContext,
  input: RenderTemplateInput,
): Promise<{ template: TemplateRecord; source: string }> {
  return ctx.repo.templates.render(input);
}

// Convenience: render the template and create the page in one transaction.
export async function createPageFromTemplate(
  ctx: ServiceContext,
  input: {
    templateId: string;
    title: string;
    folderPath?: string;
    properties?: Record<string, unknown>;
  },
): Promise<TemplateMutation<{ page: PageWithSource; templateSlug: string }>> {
  const rendered = await ctx.repo.templates.render({
    templateId: input.templateId,
    title: input.title,
    properties: input.properties,
  });
  const page = await ctx.repo.pages.create({
    workspaceId: rendered.template.workspaceId,
    folderPath: input.folderPath ?? "",
    title: input.title,
    sourceType: rendered.template.sourceType,
    source: rendered.source,
  });
  const treeVersion = await ctx.computeTreeVersion(page.page.workspaceId);
  return {
    data: { page, templateSlug: rendered.template.slug },
    envelope: buildEnvelope({
      treeVersion,
      contentHash: page.page.contentHash,
      navigationInvalidated: true,
      changedResources: [`page:${page.page.id}`],
    }),
  };
}
