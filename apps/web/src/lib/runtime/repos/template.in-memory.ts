// In-memory TemplateRepo adapter wrapping templateService.

import type {
  TemplateRepo,
  TemplateRecord,
  TemplateWithSource,
  CreateTemplateInput,
  UpdateTemplateInput,
  RenderTemplateInput,
} from "@vegastack/pages-services";
import { templateService } from "../../runtime";

export function createInMemoryTemplateRepo(): TemplateRepo {
  return {
    async list(workspaceId: string): Promise<TemplateRecord[]> {
      return templateService.listTemplates(workspaceId);
    },
    async get(templateId: string): Promise<TemplateRecord | null> {
      return templateService.getTemplate(templateId);
    },
    async getWithSource(
      templateId: string,
    ): Promise<TemplateWithSource | null> {
      return templateService.getTemplateWithSource(templateId);
    },
    async create(input: CreateTemplateInput): Promise<TemplateWithSource> {
      const result = await templateService.createTemplate({
        id: input.id,
        workspaceId: input.workspaceId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? "",
        category: input.category ?? "general",
        sourceType: input.sourceType,
        source: input.source,
        properties: input.properties,
        createdBy: input.createdBy ?? null,
      });
      return { template: result.template, source: result.source };
    },
    async update(input: UpdateTemplateInput): Promise<TemplateWithSource> {
      const result = await templateService.updateTemplate({
        templateId: input.templateId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        category: input.category,
        sourceType: input.sourceType,
        source: input.source,
        properties: input.properties,
        updatedBy: input.updatedBy ?? null,
      });
      return { template: result.template, source: result.source };
    },
    async delete(templateId: string): Promise<TemplateRecord> {
      return templateService.deleteTemplate(templateId);
    },
    async render(input: RenderTemplateInput): Promise<{
      template: TemplateRecord;
      source: string;
    }> {
      const rendered = await templateService.render({
        templateId: input.templateId,
        title: input.title,
        properties: input.properties,
      });
      return { template: rendered.template, source: rendered.source };
    },
  };
}
