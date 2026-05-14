import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  TemplateBuilderDocument,
  TemplateBuilderHeadingLevel,
  TemplateBuilderSection,
  TemplateProperty,
  TemplatePropertyType,
  TemplateSourceType,
} from "@vegastack/pages-core";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

type Mode = "create" | "edit";

type TemplateEditorInitial = {
  id?: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  sourceType: TemplateSourceType;
  properties: TemplateProperty[];
  builder: Required<TemplateBuilderDocument>;
};

type Props = {
  workspaceId: string;
  mode: Mode;
  initial: TemplateEditorInitial;
};

type SectionDraft = Required<TemplateBuilderSection> & { uid: string };
type PropertyDraft = TemplateProperty & { uid: string };

const TYPE_OPTIONS: TemplatePropertyType[] = [
  "text",
  "longtext",
  "number",
  "date",
  "datetime",
  "boolean",
  "select",
  "tags",
];

const TYPE_LABELS: Record<TemplatePropertyType, string> = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  date: "Date",
  datetime: "Date & time",
  boolean: "Checkbox",
  select: "Select",
  tags: "Tags",
};

const SECTION_LEVELS: TemplateBuilderHeadingLevel[] = [2, 3, 4];

function withSectionIds(
  sections: TemplateBuilderSection[] | undefined,
): SectionDraft[] {
  const source = sections && sections.length > 0 ? sections : [];
  return source.map((section, index) => ({
    uid: `section-${index}`,
    level: section.level ?? 2,
    heading: section.heading ?? "",
    helpText: section.helpText ?? "",
    guidance: section.guidance ?? "",
    body: section.body ?? "",
  }));
}

function withPropertyIds(properties: TemplateProperty[]): PropertyDraft[] {
  return properties.map((property, index) => ({
    ...property,
    uid: `property-${index}`,
  }));
}

function defaultSection(uid: string): SectionDraft {
  return {
    uid,
    level: 2,
    heading: "",
    helpText: "",
    guidance: "",
    body: "",
  };
}

function defaultProperty(uid: string): PropertyDraft {
  return {
    uid,
    key: "",
    label: "",
    type: "text",
    required: false,
    help: "",
  };
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function defaultToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function parseDefaultValue(text: string, type: TemplatePropertyType): unknown {
  const value = text.trim();
  if (!value) return undefined;
  if (type === "tags") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return value;
}

function propertyHasInput(property: PropertyDraft): boolean {
  return Boolean(
    property.key.trim() ||
    property.label.trim() ||
    property.help?.trim() ||
    property.default !== undefined ||
    (property.options && property.options.length > 0),
  );
}

function propertyDisplayName(property: PropertyDraft, index: number): string {
  return property.label.trim() || property.key.trim() || `Field ${index + 1}`;
}

function sectionDisplayName(section: SectionDraft, index: number): string {
  return section.heading.trim() || `Section ${index + 1}`;
}

function sectionLevelName(level: TemplateBuilderHeadingLevel): string {
  if (level === 3) return "Subsection";
  if (level === 4) return "Detail";
  return "Section";
}

export function WorkspaceTemplateEditor({ workspaceId, mode, initial }: Props) {
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [category, setCategory] = useState(initial.category || "general");
  const [description, setDescription] = useState(initial.description);
  const [sourceType, setSourceType] = useState<TemplateSourceType>(
    initial.sourceType,
  );
  const [title, setTitle] = useState(initial.builder.title);
  const [intro, setIntro] = useState(initial.builder.intro);
  const [sections, setSections] = useState<SectionDraft[]>(
    withSectionIds(initial.builder.sections),
  );
  const [properties, setProperties] = useState<PropertyDraft[]>(
    withPropertyIds(initial.properties),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    kind: "idle" | "pending" | "success" | "error";
    message: string;
  }>({ kind: "idle", message: "" });

  const nextSectionUid = useMemo(
    () => `section-${sections.length}-${Date.now()}`,
    [sections.length],
  );
  const nextPropertyUid = useMemo(
    () => `property-${properties.length}-${Date.now()}`,
    [properties.length],
  );

  function updateSection(index: number, patch: Partial<SectionDraft>) {
    setSections((current) =>
      current.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, ...patch } : section,
      ),
    );
  }

  function updateProperty(index: number, patch: Partial<PropertyDraft>) {
    setProperties((current) =>
      current.map((property, propertyIndex) =>
        propertyIndex === index ? { ...property, ...patch } : property,
      ),
    );
  }

  function cleanedProperties(): TemplateProperty[] {
    return properties.filter(propertyHasInput).map((property) => {
      const defaultValue = parseDefaultValue(
        defaultToText(property.default),
        property.type,
      );
      return {
        key: property.key.trim(),
        label: property.label.trim(),
        type: property.type,
        required: property.required === true,
        ...(property.help?.trim() ? { help: property.help.trim() } : {}),
        ...(property.type === "select"
          ? { options: property.options ?? [] }
          : {}),
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      };
    });
  }

  function builderPayload(): Required<TemplateBuilderDocument> {
    return {
      title: title.trim() || "{{ title }}",
      intro: intro.trim(),
      sections: sections.map((section, index) => ({
        level: section.level,
        heading: section.heading.trim() || `Section ${index + 1}`,
        helpText: section.helpText.trim(),
        guidance: section.guidance.trim(),
        body: section.body.trim(),
      })),
    };
  }

  function validate(): string | null {
    if (!name.trim()) return "Template name is required.";
    const filledProperties = properties.filter(propertyHasInput);
    for (const property of filledProperties) {
      if (!property.key.trim()) return "Every frontmatter field needs a key.";
      if (property.type === "select" && (property.options ?? []).length === 0) {
        return `Select field "${property.key}" needs at least one option.`;
      }
    }
    return null;
  }

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();
    const validationMessage = validate();
    if (validationMessage) {
      setStatus({ kind: "error", message: validationMessage });
      toast.error(validationMessage);
      return;
    }

    setBusy(true);
    setStatus({ kind: "pending", message: "Saving template..." });
    try {
      const response = await fetch(
        mode === "create"
          ? `/api/workspaces/${workspaceId}/templates`
          : `/api/templates/${initial.id}?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            slug: slug.trim() || undefined,
            description,
            category,
            source_type: sourceType,
            properties: cleanedProperties(),
            builder: builderPayload(),
          }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Template save failed.");
      }

      setStatus({ kind: "idle", message: "" });
      toast.success(
        mode === "create" ? "Template created." : "Template saved.",
      );
      if (mode === "create" && body?.template?.id) {
        window.location.assign(`/app/settings/templates/${body.template.id}`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Template save failed.";
      setStatus({ kind: "error", message });
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="template-editor-form" onSubmit={handleSubmit}>
      <section className="template-editor-group">
        <header className="template-editor-section-header">
          <div>
            <h2>Details</h2>
            <p>
              These fields control how the template appears in the new page
              picker and MCP tools.
            </p>
          </div>
        </header>
        <div className="settings-card template-editor-card">
          <div className="template-editor-grid">
            <label className="vpg-field">
              <span>Name</span>
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="PRD"
                autoComplete="off"
              />
            </label>
            <label className="vpg-field">
              <span>Slug</span>
              <Input
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="prd"
                autoComplete="off"
              />
            </label>
            <label className="vpg-field">
              <span>Category</span>
              <Input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="product"
                autoComplete="off"
              />
            </label>
            <label className="vpg-field">
              <span>Source type</span>
              <Select
                value={sourceType}
                onValueChange={(value) =>
                  setSourceType(value === "mdx" ? "mdx" : "markdown")
                }
              >
                <SelectTrigger aria-label="Source type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="markdown">Markdown</SelectItem>
                  <SelectItem value="mdx">MDX</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="vpg-field template-editor-span">
              <span>Description</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="One-line description for the picker."
              />
            </label>
          </div>
        </div>
      </section>

      <section className="template-editor-group">
        <header className="template-editor-section-header">
          <div>
            <h2>Frontmatter fields</h2>
            <p>
              Typed prompts collected before a page is created from this
              template.
            </p>
          </div>
        </header>

        <div className="settings-card template-editor-card">
          {properties.length === 0 ? (
            <div className="settings-empty template-editor-empty">
              <p>
                <strong>No frontmatter fields</strong>
                Add a field when the page creator should provide typed metadata.
              </p>
            </div>
          ) : (
            <ul className="template-editor-list">
              {properties.map((property, index) => (
                <li key={property.uid} className="template-property-row">
                  <header className="template-editor-row-top">
                    <div className="template-row-title">
                      <span>Field {index + 1}</span>
                      <strong>{propertyDisplayName(property, index)}</strong>
                    </div>
                    <div className="template-editor-row-tools">
                      {property.required ? (
                        <span className="template-row-chip">Required</span>
                      ) : null}
                      <div className="template-editor-row-actions">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={index === 0}
                          onClick={() =>
                            setProperties((current) =>
                              moveItem(current, index, -1),
                            )
                          }
                          aria-label="Move field up"
                          title="Move up"
                        >
                          <ArrowUp size={14} aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={index === properties.length - 1}
                          onClick={() =>
                            setProperties((current) =>
                              moveItem(current, index, 1),
                            )
                          }
                          aria-label="Move field down"
                          title="Move down"
                        >
                          <ArrowDown size={14} aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setProperties((current) =>
                              current.filter(
                                (_, propertyIndex) => propertyIndex !== index,
                              ),
                            )
                          }
                          aria-label="Remove field"
                          title="Remove field"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </header>

                  <div className="template-property-grid">
                    <label className="vpg-field">
                      <span>Key</span>
                      <Input
                        value={property.key}
                        onChange={(event) =>
                          updateProperty(index, { key: event.target.value })
                        }
                        placeholder="owner"
                        autoComplete="off"
                      />
                    </label>
                    <label className="vpg-field">
                      <span>Label</span>
                      <Input
                        value={property.label}
                        onChange={(event) =>
                          updateProperty(index, { label: event.target.value })
                        }
                        placeholder="Owner"
                        autoComplete="off"
                      />
                    </label>
                    <label className="vpg-field">
                      <span>Type</span>
                      <Select
                        value={property.type}
                        onValueChange={(value) => {
                          const type = value as TemplatePropertyType;
                          updateProperty(index, {
                            type,
                            options:
                              type === "select"
                                ? (property.options ?? [])
                                : undefined,
                            default: undefined,
                          });
                        }}
                      >
                        <SelectTrigger aria-label="Field type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TYPE_OPTIONS.map((option) => (
                            <SelectItem key={option} value={option}>
                              {TYPE_LABELS[option]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="vpg-field">
                      <span>Default</span>
                      <Input
                        value={defaultToText(property.default)}
                        onChange={(event) =>
                          updateProperty(index, {
                            default: parseDefaultValue(
                              event.target.value,
                              property.type,
                            ),
                          })
                        }
                        placeholder={
                          property.type === "tags"
                            ? "docs, review"
                            : property.type === "boolean"
                              ? "true"
                              : "draft"
                        }
                        autoComplete="off"
                      />
                    </label>
                    {property.type === "select" ? (
                      <label className="vpg-field template-editor-span">
                        <span>Options</span>
                        <Input
                          value={(property.options ?? []).join(", ")}
                          onChange={(event) =>
                            updateProperty(index, {
                              options: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="draft, in_review, shipped"
                          autoComplete="off"
                        />
                      </label>
                    ) : null}
                    <label className="vpg-field template-editor-span">
                      <span>Help text</span>
                      <Input
                        value={property.help ?? ""}
                        onChange={(event) =>
                          updateProperty(index, { help: event.target.value })
                        }
                        placeholder="Shown when creating a page from this template."
                        autoComplete="off"
                      />
                    </label>
                    <label className="vpg-inline-check template-required-check">
                      <input
                        type="checkbox"
                        checked={property.required ?? false}
                        onChange={(event) =>
                          updateProperty(index, {
                            required: event.target.checked,
                          })
                        }
                      />
                      <span>Required</span>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="template-editor-full-action template-editor-outline-action"
            onClick={() =>
              setProperties((current) => [
                ...current,
                defaultProperty(nextPropertyUid),
              ])
            }
          >
            <Plus size={14} aria-hidden="true" />
            Add field
          </Button>
        </div>
      </section>

      <section className="template-editor-group">
        <header className="template-editor-section-header">
          <div>
            <h2>Template body</h2>
            <p>
              Build the page scaffold with editable headings and agent guidance.
              It is saved as Markdown.
            </p>
          </div>
        </header>

        <div className="settings-card template-editor-card">
          <div className="template-editor-grid">
            <label className="vpg-field">
              <span>Page title heading</span>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="{{ title }}"
                autoComplete="off"
              />
            </label>
            <label className="vpg-field template-editor-span">
              <span>Intro text</span>
              <Textarea
                value={intro}
                onChange={(event) => setIntro(event.target.value)}
                rows={3}
                placeholder="Optional text shown before the first section."
              />
            </label>
          </div>

          <ul className="template-editor-list">
            {sections.map((section, index) => (
              <li key={section.uid} className="template-section-row">
                <header className="template-editor-row-top template-section-row-top">
                  <div className="template-section-heading-preview">
                    <span className="template-section-level-badge">
                      <span>{sectionLevelName(section.level)}</span>
                      <code>H{section.level}</code>
                    </span>
                    <div className="template-row-title">
                      <span>Block {index + 1}</span>
                      <strong>{sectionDisplayName(section, index)}</strong>
                    </div>
                  </div>
                  <div className="template-editor-row-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={index === 0}
                      onClick={() =>
                        setSections((current) => moveItem(current, index, -1))
                      }
                      aria-label="Move section up"
                      title="Move up"
                    >
                      <ArrowUp size={14} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={index === sections.length - 1}
                      onClick={() =>
                        setSections((current) => moveItem(current, index, 1))
                      }
                      aria-label="Move section down"
                      title="Move down"
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={sections.length === 1}
                      onClick={() =>
                        setSections((current) =>
                          current.filter(
                            (_, sectionIndex) => sectionIndex !== index,
                          ),
                        )
                      }
                      aria-label="Remove section"
                      title="Remove section"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  </div>
                </header>

                <div className="template-section-grid">
                  <label className="vpg-field template-heading-level">
                    <span>Structure</span>
                    <Select
                      value={String(section.level)}
                      onValueChange={(value) =>
                        updateSection(index, {
                          level: Number(value) as TemplateBuilderHeadingLevel,
                        })
                      }
                    >
                      <SelectTrigger aria-label="Section structure">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SECTION_LEVELS.map((level) => (
                          <SelectItem key={level} value={String(level)}>
                            {sectionLevelName(level)} (H{level})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="vpg-field">
                    <span>Heading</span>
                    <Input
                      value={section.heading}
                      onChange={(event) =>
                        updateSection(index, { heading: event.target.value })
                      }
                      placeholder="Problem"
                      autoComplete="off"
                    />
                  </label>
                  <label className="vpg-field template-editor-span">
                    <span>Visible help text</span>
                    <Textarea
                      value={section.helpText}
                      onChange={(event) =>
                        updateSection(index, { helpText: event.target.value })
                      }
                      rows={2}
                      placeholder="Optional text rendered under this heading."
                    />
                  </label>
                  <label className="vpg-field template-editor-span">
                    <span>Agent guidance</span>
                    <Textarea
                      value={section.guidance}
                      onChange={(event) =>
                        updateSection(index, { guidance: event.target.value })
                      }
                      rows={2}
                      placeholder="Instruction stored as a Markdown HTML comment."
                    />
                  </label>
                  <label className="vpg-field template-editor-span">
                    <span>Starter body</span>
                    <Textarea
                      value={section.body}
                      onChange={(event) =>
                        updateSection(index, { body: event.target.value })
                      }
                      rows={4}
                      placeholder="Optional starter Markdown for this section."
                    />
                  </label>
                </div>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="template-editor-full-action template-editor-outline-action"
            onClick={() =>
              setSections((current) => [
                ...current,
                defaultSection(nextSectionUid),
              ])
            }
          >
            <Plus size={14} aria-hidden="true" />
            Add section
          </Button>
        </div>
      </section>

      <footer className="settings-card-footer template-editor-footer">
        {status.kind !== "idle" ? (
          <p className="settings-status" data-state={status.kind}>
            {status.message}
          </p>
        ) : null}
        <a
          className="vpg-button vpg-button-ghost vpg-button-md"
          href="/app/settings/templates"
        >
          Cancel
        </a>
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={busy}
          data-pending={busy ? "true" : undefined}
        >
          <span className="settings-button-label">
            <Save size={14} aria-hidden="true" />
            {mode === "create" ? "Create template" : "Save changes"}
          </span>
          <span className="settings-button-spinner-wrap">
            <span className="settings-button-spinner" aria-hidden="true" />
          </span>
        </Button>
      </footer>
    </form>
  );
}
