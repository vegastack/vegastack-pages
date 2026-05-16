// TemplateRepo — workspace-scoped page templates.
//
// Templates are markdown sources with frontmatter-style properties that
// are rendered into page content via `render({ templateId, title,
// properties })`. Each template has a slug (unique within workspace)
// and an `is_builtin` flag (system-provided templates).

import type {
  TemplateBuilderDocument,
  TemplateProperty,
} from "@vegastack/pages-core";

export type { TemplateBuilderDocument, TemplateProperty };

export type TemplateRecord = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  sourceType: "markdown" | "mdx";
  objectKeyCurrent: string;
  contentHash: string;
  versionId: string;
  properties: TemplateProperty[];
  isBuiltin: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TemplateWithSource = {
  template: TemplateRecord;
  source: string;
};

export type CreateTemplateInput = {
  id?: string;
  workspaceId: string;
  name: string;
  slug?: string;
  description?: string;
  category?: string;
  sourceType: "markdown" | "mdx";
  source: string;
  properties?: TemplateProperty[];
  createdBy?: string | null;
};

export type UpdateTemplateInput = {
  templateId: string;
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
  sourceType?: "markdown" | "mdx";
  source?: string;
  properties?: TemplateProperty[];
  updatedBy?: string | null;
};

export type RenderTemplateInput = {
  templateId: string;
  title: string;
  properties?: Record<string, unknown>;
};

export type TemplateRepo = {
  list(workspaceId: string): Promise<TemplateRecord[]>;
  get(templateId: string): Promise<TemplateRecord | null>;
  getWithSource(templateId: string): Promise<TemplateWithSource | null>;
  create(input: CreateTemplateInput): Promise<TemplateWithSource>;
  update(input: UpdateTemplateInput): Promise<TemplateWithSource>;
  delete(templateId: string): Promise<TemplateRecord>;
  // Renders the template source with provided properties. Returns the
  // markdown/mdx body that callers can feed into pageService.create.
  render(
    input: RenderTemplateInput,
  ): Promise<{ template: TemplateRecord; source: string }>;
};
