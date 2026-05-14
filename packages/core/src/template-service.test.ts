import { describe, expect, it } from "vitest";
import {
  AppError,
  InMemoryObjectStore,
  TemplateService,
  builtinTemplates,
  templateBuilderFromMarkdown,
  templateBuilderToMarkdown,
  normalizeProperty,
  normalizeProperties,
} from ".";

function makeService() {
  return new TemplateService(new InMemoryObjectStore());
}

describe("TemplateService.normalizeProperty", () => {
  it("rejects invalid keys", () => {
    expect(() =>
      normalizeProperty({ key: "Bad Key", label: "x", type: "text" }, 0),
    ).toThrow(AppError);
    expect(() =>
      normalizeProperty({ key: "9start", label: "x", type: "text" }, 0),
    ).toThrow(AppError);
  });

  it("requires options for select and rejects them otherwise", () => {
    expect(() =>
      normalizeProperty(
        { key: "status", label: "Status", type: "select", options: [] },
        0,
      ),
    ).toThrow(AppError);
    expect(() =>
      normalizeProperty(
        { key: "owner", label: "Owner", type: "text", options: ["x"] },
        0,
      ),
    ).toThrow(AppError);
    const property = normalizeProperty(
      {
        key: "status",
        label: "",
        type: "select",
        options: ["draft", "shipped"],
      },
      0,
    );
    expect(property.label).toBe("status");
    expect(property.options).toEqual(["draft", "shipped"]);
  });

  it("rejects unsupported and duplicate properties while preserving help text", () => {
    expect(() =>
      normalizeProperty(
        {
          key: "owner",
          label: "Owner",
          type: "unknown" as "text",
        },
        0,
      ),
    ).toThrow(AppError);

    expect(() =>
      normalizeProperties([
        { key: "owner", label: "Owner", type: "text" },
        { key: "owner", label: "Duplicate", type: "text" },
      ]),
    ).toThrow(AppError);

    expect(
      normalizeProperty(
        {
          key: "notes",
          label: "Notes",
          type: "longtext",
          help: "  Give reviewers enough context.  ",
        },
        0,
      ).help,
    ).toBe("Give reviewers enough context.");
  });

  it("coerces default values to the property type", () => {
    const number = normalizeProperty(
      { key: "n", label: "N", type: "number", default: "3" },
      0,
    );
    expect(number.default).toBe(3);
    const bool = normalizeProperty(
      { key: "b", label: "B", type: "boolean", default: "true" },
      0,
    );
    expect(bool.default).toBe(true);
  });

  it("rejects invalid defaults for strongly typed properties", () => {
    expect(() =>
      normalizeProperty(
        { key: "n", label: "N", type: "number", default: "NaN" },
        0,
      ),
    ).toThrow(AppError);
    expect(() =>
      normalizeProperty(
        { key: "b", label: "B", type: "boolean", default: "sure" },
        0,
      ),
    ).toThrow(AppError);
    expect(() =>
      normalizeProperty(
        { key: "d", label: "D", type: "date", default: "2026/05/12" },
        0,
      ),
    ).toThrow(AppError);
    expect(() =>
      normalizeProperty(
        { key: "dt", label: "DT", type: "datetime", default: "not-a-date" },
        0,
      ),
    ).toThrow(AppError);
    expect(() =>
      normalizeProperty(
        { key: "tags", label: "Tags", type: "tags", default: "docs" },
        0,
      ),
    ).toThrow(AppError);
  });
});

describe("template builder", () => {
  it("converts structured sections to markdown", () => {
    const markdown = templateBuilderToMarkdown({
      title: "{{ title }}",
      intro: "Short context for the page.",
      sections: [
        {
          level: 2,
          heading: "Problem",
          helpText: "State the user pain clearly.",
          guidance: "2-4 sentences. No solutions yet.",
          body: "- Add evidence here.",
        },
        {
          level: 3,
          heading: "Open question",
          guidance: "Name the decision owner.",
        },
      ],
    });

    expect(markdown).toContain("# {{ title }}");
    expect(markdown).toContain("Short context for the page.");
    expect(markdown).toContain("## Problem");
    expect(markdown).toContain("State the user pain clearly.");
    expect(markdown).toContain(
      "<!-- guidance: 2-4 sentences. No solutions yet. -->",
    );
    expect(markdown).toContain("### Open question");
  });

  it("parses existing markdown into editable builder sections", () => {
    const builder = templateBuilderFromMarkdown(`# {{ title }}

Intro paragraph.

## Summary
Visible help.
<!-- guidance: One paragraph for reviewers. -->
Draft notes.

### Detail
More body.
`);

    expect(builder.title).toBe("{{ title }}");
    expect(builder.intro).toBe("Intro paragraph.");
    expect(builder.sections).toEqual([
      {
        level: 2,
        heading: "Summary",
        helpText: "Visible help.",
        guidance: "One paragraph for reviewers.",
        body: "Draft notes.",
      },
      {
        level: 3,
        heading: "Detail",
        helpText: "",
        guidance: "",
        body: "More body.",
      },
    ]);
  });
});

describe("TemplateService CRUD", () => {
  it("creates a template, enforces unique slug, and lists by workspace", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "PRD",
      source: "# {{ title }}\n",
      properties: [
        { key: "owner", label: "Owner", type: "text", required: true },
      ],
    });
    expect(created.template.slug).toBe("prd");
    expect(created.template.properties).toEqual([
      { key: "owner", label: "Owner", type: "text", required: true },
    ]);

    await expect(
      service.createTemplate({
        workspaceId: "wks_test",
        name: "PRD",
        source: "x",
      }),
    ).rejects.toBeInstanceOf(AppError);

    const other = await service.createTemplate({
      workspaceId: "wks_other",
      name: "PRD",
      source: "x",
    });
    expect(other.template.slug).toBe("prd");

    expect(service.listTemplates("wks_test").map((t) => t.slug)).toEqual([
      "prd",
    ]);
  });

  it("updates source and emits a new version", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Brief",
      source: "v1",
    });
    const updated = await service.updateTemplate({
      templateId: created.template.id,
      source: "v2",
      name: "Brief 2",
    });
    expect(updated.template.name).toBe("Brief 2");
    expect(updated.source).toBe("v2");
    expect(updated.template.versionId).not.toBe(created.template.versionId);
    expect(service.listVersions(created.template.id)).toHaveLength(2);
  });

  it("updates metadata without creating a new version", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Brief",
      slug: "brief",
      source: "v1",
      category: "docs",
      description: "Initial",
    });

    const updated = await service.updateTemplate({
      templateId: created.template.id,
      slug: "brief-v2",
      description: " Revised ",
      category: " ",
    });

    expect(updated.template.slug).toBe("brief-v2");
    expect(updated.template.description).toBe("Revised");
    expect(updated.template.category).toBe("general");
    expect(updated.template.versionId).toBe(created.template.versionId);
    expect(updated.source).toBe("v1");
    expect(service.getTemplateBySlug("wks_test", "brief-v2")?.id).toBe(
      created.template.id,
    );
    expect(service.getTemplateBySlug("wks_test", "brief")).toBeNull();
    expect(service.listVersions(created.template.id)).toHaveLength(1);
  });

  it("rejects missing templates and missing source objects", async () => {
    const store = new InMemoryObjectStore();
    const service = new TemplateService(store);
    await expect(
      service.updateTemplate({ templateId: "tpl_missing", source: "x" }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(service.deleteTemplate("tpl_missing")).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(
      service.render({ templateId: "tpl_missing", title: "x" }),
    ).rejects.toBeInstanceOf(AppError);

    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Brief",
      source: "v1",
    });
    await store.delete(created.template.objectKeyCurrent);

    await expect(
      service.getTemplateWithSource(created.template.id),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("deletes a template and frees its slug", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Brief",
      source: "x",
    });
    service.deleteTemplate(created.template.id);
    expect(service.getTemplate(created.template.id)).toBeNull();
    const recreated = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Brief",
      source: "x",
    });
    expect(recreated.template.slug).toBe("brief");
  });
});

describe("TemplateService.render", () => {
  it("substitutes title/date, coerces values, and builds frontmatter", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "PRD",
      source: "# {{ title }}\n\nCreated {{ date }}.",
      properties: [
        { key: "owner", label: "Owner", type: "text", required: true },
        {
          key: "status",
          label: "Status",
          type: "select",
          options: ["draft", "shipped"],
          default: "draft",
        },
        { key: "priority", label: "Priority", type: "number" },
        { key: "tags", label: "Tags", type: "tags" },
        { key: "confidential", label: "Confidential", type: "boolean" },
      ],
    });

    const rendered = await service.render({
      templateId: created.template.id,
      title: "Cohort exports",
      properties: {
        owner: "Manoj",
        priority: "2",
        tags: ["data", "exports"],
        confidential: true,
      },
      now: new Date("2026-05-12T00:00:00Z"),
    });

    expect(rendered.frontmatter).toEqual({
      owner: "Manoj",
      status: "draft",
      priority: 2,
      tags: ["data", "exports"],
      confidential: true,
    });
    expect(rendered.source).toContain("---\nowner: Manoj");
    expect(rendered.source).toContain("status: draft");
    expect(rendered.source).toContain("priority: 2");
    expect(rendered.source).toContain("  - data");
    expect(rendered.source).toContain("confidential: true");
    expect(rendered.source).toContain("# Cohort exports");
    expect(rendered.source).toContain("Created 2026-05-12.");
  });

  it("requires required properties", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "PRD",
      source: "{{ title }}",
      properties: [
        { key: "owner", label: "Owner", type: "text", required: true },
      ],
    });
    await expect(
      service.render({
        templateId: created.template.id,
        title: "X",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects select values outside the options list", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "PRD",
      source: "{{ title }}",
      properties: [
        {
          key: "status",
          label: "Status",
          type: "select",
          options: ["draft", "shipped"],
        },
      ],
    });
    await expect(
      service.render({
        templateId: created.template.id,
        title: "X",
        properties: { status: "in_review" },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("renders fallback values and YAML-safe scalars", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Runbook",
      source: "# {{title}}\n\nUpdated {{date}}.",
      properties: [
        { key: "enabled", label: "Enabled", type: "boolean" },
        { key: "estimate", label: "Estimate", type: "number" },
        { key: "status", label: "Status", type: "text" },
        { key: "tags", label: "Tags", type: "tags" },
      ],
    });

    const rendered = await service.render({
      templateId: created.template.id,
      title: "Release Runbook",
      properties: { status: "yes", tags: [] },
      now: new Date("2026-05-12T12:00:00Z"),
    });

    expect(rendered.frontmatter).toEqual({
      enabled: false,
      estimate: 0,
      status: "yes",
      tags: [],
    });
    expect(rendered.source).toContain("enabled: false");
    expect(rendered.source).toContain("estimate: 0");
    expect(rendered.source).toContain('status: "yes"');
    expect(rendered.source).toContain("tags: []");
    expect(rendered.body).toContain("# Release Runbook");
    expect(rendered.body).toContain("Updated 2026-05-12.");
  });

  it("rejects empty titles before rendering", async () => {
    const service = makeService();
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Brief",
      source: "{{ title }}",
    });

    await expect(
      service.render({ templateId: created.template.id, title: "   " }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("preserves HTML comment guidance in the rendered body", async () => {
    const service = makeService();
    const body = "## Problem\n<!-- guidance: describe the problem -->";
    const created = await service.createTemplate({
      workspaceId: "wks_test",
      name: "Brief",
      source: body,
    });
    const rendered = await service.render({
      templateId: created.template.id,
      title: "x",
    });
    expect(rendered.source).toContain(
      "<!-- guidance: describe the problem -->",
    );
  });
});

describe("builtinTemplates", () => {
  it("has 15 templates with unique slugs and valid properties", () => {
    expect(builtinTemplates).toHaveLength(15);
    const slugs = new Set(builtinTemplates.map((t) => t.slug));
    expect(slugs.size).toBe(builtinTemplates.length);
    for (const spec of builtinTemplates) {
      expect(spec.body).toContain("{{ title }}");
      const seen = new Set<string>();
      for (const property of spec.properties) {
        expect(property.key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(seen.has(property.key)).toBe(false);
        seen.add(property.key);
      }
    }
  });

  it("can seed every builtin into a TemplateService", async () => {
    const service = makeService();
    for (const spec of builtinTemplates) {
      const created = await service.createTemplate({
        workspaceId: "wks_test",
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        category: spec.category,
        source: spec.body,
        properties: spec.properties,
        isBuiltin: true,
      });
      expect(created.template.isBuiltin).toBe(true);
    }
    expect(service.listTemplates("wks_test")).toHaveLength(15);
  });
});
