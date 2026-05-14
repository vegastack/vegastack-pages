import { AppError } from "./errors";
import { createId, idPrefixes, slugifyTitle } from "./ids";
import type { ObjectStore } from "./object-store";

export type TemplateSourceType = "markdown" | "mdx";

export type TemplatePropertyType =
  | "text"
  | "longtext"
  | "number"
  | "date"
  | "datetime"
  | "boolean"
  | "select"
  | "tags";

export type TemplateProperty = {
  key: string;
  label: string;
  type: TemplatePropertyType;
  required?: boolean;
  default?: unknown;
  options?: string[];
  help?: string;
};

export type TemplateRecord = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  sourceType: TemplateSourceType;
  objectKeyCurrent: string;
  contentHash: string;
  versionId: string;
  properties: TemplateProperty[];
  isBuiltin: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TemplateVersionRecord = {
  id: string;
  templateId: string;
  workspaceId: string;
  objectKey: string;
  sourceHash: string;
  sourceType: TemplateSourceType;
  properties: TemplateProperty[];
  label: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type TemplateWithSource = {
  template: TemplateRecord;
  source: string;
};

export type CreateTemplateInput = {
  id?: string;
  workspaceId: string;
  slug?: string;
  name: string;
  description?: string;
  category?: string;
  sourceType?: TemplateSourceType;
  source: string;
  properties?: TemplateProperty[];
  isBuiltin?: boolean;
  createdBy?: string | null;
};

export type UpdateTemplateInput = {
  templateId: string;
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
  sourceType?: TemplateSourceType;
  source?: string;
  properties?: TemplateProperty[];
  updatedBy?: string | null;
};

export type RenderTemplateInput = {
  templateId: string;
  title: string;
  properties?: Record<string, unknown>;
  now?: Date;
};

export type RenderedTemplate = {
  template: TemplateRecord;
  source: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

const PROPERTY_TYPES: ReadonlySet<TemplatePropertyType> = new Set([
  "text",
  "longtext",
  "number",
  "date",
  "datetime",
  "boolean",
  "select",
  "tags",
]);

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extensionFor(sourceType: TemplateSourceType): string {
  return sourceType === "mdx" ? "mdx" : "md";
}

function contentTypeFor(sourceType: TemplateSourceType): string {
  return sourceType === "mdx"
    ? "text/markdown; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

export function normalizeProperty(
  property: TemplateProperty,
  index: number,
): TemplateProperty {
  const key = String(property.key ?? "").trim();
  if (!KEY_PATTERN.test(key)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Property #${index + 1} key must be lowercase letters, digits, and underscores, starting with a letter.`,
      400,
      { key },
    );
  }
  const type = property.type;
  if (!PROPERTY_TYPES.has(type)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Property "${key}" has an unsupported type: ${String(type)}`,
      400,
    );
  }
  const label = (property.label ?? "").trim() || key;
  let options: string[] | undefined;
  if (type === "select") {
    const raw = Array.isArray(property.options) ? property.options : [];
    options = raw
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
    if (options.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Property "${key}" is a select but has no options.`,
        400,
      );
    }
  } else if (Array.isArray(property.options) && property.options.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Property "${key}" cannot define options because it is not a select.`,
      400,
    );
  }
  const help = property.help?.trim() ? property.help.trim() : undefined;
  const required = property.required === true;
  let defaultValue: unknown = undefined;
  if (property.default !== undefined && property.default !== null) {
    defaultValue = coerceValue(property.default, type, options);
  }
  return {
    key,
    label,
    type,
    required,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(options ? { options } : {}),
    ...(help ? { help } : {}),
  };
}

export function normalizeProperties(
  properties: TemplateProperty[] | undefined,
): TemplateProperty[] {
  if (!properties || properties.length === 0) return [];
  const seen = new Set<string>();
  return properties.map((property, index) => {
    const normalized = normalizeProperty(property, index);
    if (seen.has(normalized.key)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Duplicate property key: ${normalized.key}`,
        400,
      );
    }
    seen.add(normalized.key);
    return normalized;
  });
}

function coerceValue(
  value: unknown,
  type: TemplatePropertyType,
  options: string[] | undefined,
): unknown {
  switch (type) {
    case "text":
    case "longtext": {
      return String(value);
    }
    case "number": {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Value "${String(value)}" is not a number.`,
          400,
        );
      }
      return num;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      throw new AppError(
        "VALIDATION_ERROR",
        `Value "${String(value)}" is not a boolean.`,
        400,
      );
    }
    case "date": {
      const text = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Value "${text}" is not an ISO date (YYYY-MM-DD).`,
          400,
        );
      }
      return text;
    }
    case "datetime": {
      const text = String(value).trim();
      if (Number.isNaN(Date.parse(text))) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Value "${text}" is not a valid datetime.`,
          400,
        );
      }
      return text;
    }
    case "select": {
      const text = String(value);
      if (options && !options.includes(text)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Value "${text}" is not in the allowed options.`,
          400,
          { allowed: options },
        );
      }
      return text;
    }
    case "tags": {
      if (!Array.isArray(value)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Tags value must be an array of strings.`,
          400,
        );
      }
      return value.map((entry) => String(entry).trim()).filter(Boolean);
    }
    default: {
      return value;
    }
  }
}

function escapeYamlString(value: string): string {
  if (
    value === "" ||
    /[:#&*!|>'"%@`]/.test(value) ||
    /^[\s-?]/.test(value) ||
    /\s$/.test(value) ||
    /\n/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^-?\d/.test(value)
  ) {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return value;
}

function yamlScalar(value: unknown, type: TemplatePropertyType): string {
  if (value === null || value === undefined) return '""';
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return String(value);
  return escapeYamlString(String(value));
}

function yamlForProperties(
  properties: TemplateProperty[],
  values: Record<string, unknown>,
): string {
  const lines: string[] = [];
  for (const property of properties) {
    const raw = values[property.key];
    if (property.type === "tags") {
      const list = Array.isArray(raw) ? (raw as unknown[]) : [];
      if (list.length === 0) {
        lines.push(`${property.key}: []`);
      } else {
        lines.push(`${property.key}:`);
        for (const item of list) {
          lines.push(`  - ${escapeYamlString(String(item))}`);
        }
      }
      continue;
    }
    if (raw === undefined || raw === null || raw === "") {
      if (property.type === "boolean") {
        lines.push(`${property.key}: false`);
      } else if (property.type === "number") {
        lines.push(`${property.key}: 0`);
      } else {
        lines.push(`${property.key}: ""`);
      }
      continue;
    }
    lines.push(`${property.key}: ${yamlScalar(raw, property.type)}`);
  }
  return lines.join("\n");
}

export function renderTemplateBody(
  body: string,
  title: string,
  now: Date,
): string {
  const isoDate = now.toISOString().slice(0, 10);
  return body
    .replaceAll("{{ title }}", title)
    .replaceAll("{{title}}", title)
    .replaceAll("{{ date }}", isoDate)
    .replaceAll("{{date}}", isoDate);
}

export class TemplateService {
  private readonly templates = new Map<string, TemplateRecord>();
  private readonly slugIndex = new Map<string, string>();
  private readonly versions = new Map<string, TemplateVersionRecord[]>();

  constructor(private readonly objectStore: ObjectStore) {}

  private slugKey(workspaceId: string, slug: string): string {
    return `${workspaceId}::${slug}`;
  }

  private ensureUniqueSlug(
    workspaceId: string,
    slug: string,
    ignoreTemplateId?: string,
  ): string {
    const normalized = slugifyTitle(slug);
    const owner = this.slugIndex.get(this.slugKey(workspaceId, normalized));
    if (owner && owner !== ignoreTemplateId) {
      throw new AppError(
        "VALIDATION_ERROR",
        `A template with slug "${normalized}" already exists in this workspace.`,
        400,
      );
    }
    return normalized;
  }

  async createTemplate(
    input: CreateTemplateInput,
  ): Promise<TemplateWithSource> {
    const name = input.name.trim();
    if (!name) {
      throw new AppError("VALIDATION_ERROR", "Template name is required.", 400);
    }
    const sourceType = input.sourceType ?? "markdown";
    const properties = normalizeProperties(input.properties);
    const id = input.id ?? createId(idPrefixes.template);
    const slug = this.ensureUniqueSlug(
      input.workspaceId,
      input.slug?.trim() || name,
    );
    const now = new Date().toISOString();
    const versionId = createId(idPrefixes.version);
    const baseKey = `workspaces/${input.workspaceId}/templates/${id}`;
    const objectKeyCurrent = `${baseKey}/source/current.${extensionFor(sourceType)}`;
    const versionKey = `${baseKey}/versions/${now.replaceAll(":", "-")}-${versionId}.${extensionFor(sourceType)}`;
    const source = input.source ?? "";
    const contentHash = await sha256(source);

    await this.objectStore.put(objectKeyCurrent, source, {
      contentType: contentTypeFor(sourceType),
    });
    await this.objectStore.put(versionKey, source, {
      contentType: contentTypeFor(sourceType),
    });

    const template: TemplateRecord = {
      id,
      workspaceId: input.workspaceId,
      slug,
      name,
      description: input.description?.trim() ?? "",
      category: (input.category?.trim() || "general").toLowerCase(),
      sourceType,
      objectKeyCurrent,
      contentHash,
      versionId,
      properties,
      isBuiltin: input.isBuiltin === true,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const version: TemplateVersionRecord = {
      id: versionId,
      templateId: id,
      workspaceId: input.workspaceId,
      objectKey: versionKey,
      sourceHash: contentHash,
      sourceType,
      properties,
      label: "Initial version",
      createdBy: input.createdBy ?? null,
      createdAt: now,
    };

    this.templates.set(id, template);
    this.slugIndex.set(this.slugKey(input.workspaceId, slug), id);
    this.versions.set(id, [version]);
    return { template, source };
  }

  async updateTemplate(
    input: UpdateTemplateInput,
  ): Promise<TemplateWithSource> {
    const existing = this.templates.get(input.templateId);
    if (!existing) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    const sourceType = input.sourceType ?? existing.sourceType;
    const name = input.name?.trim() || existing.name;
    if (!name) {
      throw new AppError("VALIDATION_ERROR", "Template name is required.", 400);
    }
    let slug = existing.slug;
    if (input.slug !== undefined) {
      slug = this.ensureUniqueSlug(
        existing.workspaceId,
        input.slug.trim() || name,
        existing.id,
      );
    }
    const properties = input.properties
      ? normalizeProperties(input.properties)
      : existing.properties;
    const now = new Date().toISOString();
    let source = await this.readSource(existing);
    let contentHash = existing.contentHash;
    let versionId = existing.versionId;
    let objectKeyCurrent = existing.objectKeyCurrent;

    const sourceChanged = input.source !== undefined && input.source !== source;
    const sourceTypeChanged = sourceType !== existing.sourceType;
    if (sourceChanged || sourceTypeChanged || input.properties) {
      source = input.source ?? source;
      contentHash = await sha256(source);
      versionId = createId(idPrefixes.version);
      const baseKey = `workspaces/${existing.workspaceId}/templates/${existing.id}`;
      objectKeyCurrent = `${baseKey}/source/current.${extensionFor(sourceType)}`;
      const versionKey = `${baseKey}/versions/${now.replaceAll(":", "-")}-${versionId}.${extensionFor(sourceType)}`;
      await this.objectStore.put(objectKeyCurrent, source, {
        contentType: contentTypeFor(sourceType),
      });
      await this.objectStore.put(versionKey, source, {
        contentType: contentTypeFor(sourceType),
      });
      const next: TemplateVersionRecord = {
        id: versionId,
        templateId: existing.id,
        workspaceId: existing.workspaceId,
        objectKey: versionKey,
        sourceHash: contentHash,
        sourceType,
        properties,
        label: null,
        createdBy: input.updatedBy ?? null,
        createdAt: now,
      };
      const previous = this.versions.get(existing.id) ?? [];
      this.versions.set(existing.id, [...previous, next]);
    }

    if (slug !== existing.slug) {
      this.slugIndex.delete(this.slugKey(existing.workspaceId, existing.slug));
      this.slugIndex.set(this.slugKey(existing.workspaceId, slug), existing.id);
    }

    const updated: TemplateRecord = {
      ...existing,
      slug,
      name,
      description:
        input.description === undefined
          ? existing.description
          : input.description.trim(),
      category:
        input.category === undefined
          ? existing.category
          : (input.category.trim() || "general").toLowerCase(),
      sourceType,
      objectKeyCurrent,
      contentHash,
      versionId,
      properties,
      updatedAt: now,
    };
    this.templates.set(existing.id, updated);
    return { template: updated, source };
  }

  async deleteTemplate(templateId: string): Promise<TemplateRecord> {
    const existing = this.templates.get(templateId);
    if (!existing) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    this.templates.delete(templateId);
    this.slugIndex.delete(this.slugKey(existing.workspaceId, existing.slug));
    this.versions.delete(templateId);
    return existing;
  }

  getTemplate(templateId: string): TemplateRecord | null {
    return this.templates.get(templateId) ?? null;
  }

  getTemplateBySlug(workspaceId: string, slug: string): TemplateRecord | null {
    const id = this.slugIndex.get(
      this.slugKey(workspaceId, slugifyTitle(slug)),
    );
    return id ? (this.templates.get(id) ?? null) : null;
  }

  async getTemplateWithSource(
    templateId: string,
  ): Promise<TemplateWithSource | null> {
    const template = this.templates.get(templateId);
    if (!template) return null;
    return { template, source: await this.readSource(template) };
  }

  listTemplates(workspaceId: string): TemplateRecord[] {
    return [...this.templates.values()]
      .filter((template) => template.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          left.category.localeCompare(right.category) ||
          left.name.localeCompare(right.name),
      );
  }

  listVersions(templateId: string): TemplateVersionRecord[] {
    return this.versions.get(templateId) ?? [];
  }

  async render(input: RenderTemplateInput): Promise<RenderedTemplate> {
    const template = this.templates.get(input.templateId);
    if (!template) {
      throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
    }
    const title = input.title.trim();
    if (!title) {
      throw new AppError("VALIDATION_ERROR", "Page title is required.", 400);
    }
    const supplied = input.properties ?? {};
    const collected: Record<string, unknown> = {};
    const frontmatter: Record<string, unknown> = {};

    for (const property of template.properties) {
      const present = Object.hasOwn(supplied, property.key);
      let value: unknown = present
        ? supplied[property.key]
        : (property.default ?? undefined);
      if (
        property.required &&
        (value === undefined ||
          value === null ||
          value === "" ||
          (Array.isArray(value) && value.length === 0))
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Property "${property.key}" is required.`,
          400,
        );
      }
      if (value === undefined || value === null) {
        value =
          property.type === "tags"
            ? []
            : property.type === "boolean"
              ? false
              : property.type === "number"
                ? 0
                : "";
      } else {
        value = coerceValue(value, property.type, property.options);
      }
      collected[property.key] = value;
      frontmatter[property.key] = value;
    }

    const source = await this.readSource(template);
    const renderedBody = renderTemplateBody(
      source,
      title,
      input.now ?? new Date(),
    );
    const yaml = yamlForProperties(template.properties, collected);
    const composed =
      template.properties.length > 0
        ? `---\n${yaml}\n---\n\n${renderedBody}`
        : renderedBody;

    return {
      template,
      source: composed,
      frontmatter,
      body: renderedBody,
    };
  }

  private async readSource(template: TemplateRecord): Promise<string> {
    const stored = await this.objectStore.get(template.objectKeyCurrent);
    if (!stored) {
      throw new AppError(
        "PAGE_NOT_FOUND",
        "Template source object was not found.",
        404,
      );
    }
    return stored.body;
  }
}
