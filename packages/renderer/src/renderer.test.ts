import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { flattenFrontmatter, parseFrontmatter, renderMarkdown } from ".";

describe("renderMarkdown", () => {
  it("parses YAML frontmatter without Node-only dependencies", () => {
    const parsed = parseFrontmatter("---\ntitle: Test\n---\n# Body");
    expect(parsed.frontmatter).toEqual({ title: "Test" });
    expect(parsed.content).toBe("# Body");
  });

  it("extracts frontmatter, headings, and sanitized html", async () => {
    const rendered = await renderMarkdown(`---
title: API Review
tags:
  - agent
---

# API Review

| A | B |
| - | - |
| 1 | 2 |

<script>alert("x")</script>
`);

    expect(rendered.frontmatter.title).toBe("API Review");
    expect(rendered.headings).toEqual([
      {
        depth: 1,
        href: "#user-content-api-review",
        htmlId: "user-content-api-review",
        slug: "api-review",
        text: "API Review",
      },
    ]);
    expect(rendered.html).toContain("<table>");
    expect(rendered.html).not.toContain("<script>");
    expect(flattenFrontmatter(rendered.frontmatter)).toContain(
      "title: API Review",
    );
  });

  it("adds code block language metadata before client hydration", async () => {
    const rendered = await renderMarkdown(
      "```ts\nexport const ok = true;\n```",
    );

    expect(rendered.html).toContain('data-language="ts"');
    expect(rendered.html).toContain('class="');
    expect(rendered.html).toContain("vpg-code-block");
    expect(rendered.html).toContain('class="shiki vpg-code-block"');
  });

  it("syntax-highlights fenced code blocks with dual-theme Shiki spans", async () => {
    const rendered = await renderMarkdown(
      "```ts\nexport const ok = true;\n```",
    );

    // Shiki dual-theme emits `--shiki-light` / `--shiki-dark` CSS variables
    // on each token span so the active theme picks the color at runtime.
    expect(rendered.html).toContain("--shiki-light");
    expect(rendered.html).toContain("--shiki-dark");
    // The Shiki <pre> wrapper should survive sanitize with its class intact.
    expect(rendered.html).toContain("shiki");
  });

  it("recovers indented code fences before Shiki highlighting", async () => {
    const rendered = await renderMarkdown(
      '    ```ts title="agent-review.ts"\n    export const waitUntil = "first_response";\n    ```',
    );

    expect(rendered.html).toContain('data-language="ts"');
    expect(rendered.html).toContain("vpg-code-block");
    expect(rendered.html).toContain('class="shiki vpg-code-block"');
    expect(rendered.html).toContain("--shiki-light");
    expect(rendered.html).not.toContain("```ts");
  });

  it("renders mermaid fences as docs-compatible mermaid blocks", async () => {
    const rendered = await renderMarkdown(
      "```mermaid\nflowchart LR\n  A --> B\n```",
    );

    expect(rendered.html).toContain('class="mermaid-block"');
    expect(rendered.html).toContain("data-mermaid-source");
    expect(rendered.html).toContain("flowchart LR");
    expect(rendered.html).not.toContain("language-mermaid");
  });

  it("recovers indented mermaid fences before docs-compatible rendering", async () => {
    const rendered = await renderMarkdown(
      "    ```mermaid\n    sequenceDiagram\n      Agent->>Pages: create_page\n    ```",
    );

    expect(rendered.html).toContain('class="mermaid-block"');
    expect(rendered.html).toContain("data-mermaid-source");
    expect(rendered.html).toContain("sequenceDiagram");
    expect(rendered.html).not.toContain("```mermaid");
    expect(rendered.html).not.toContain("language-mermaid");
  });

  it("renders mermaid fences in MDX-style source", async () => {
    const rendered = await renderMarkdown(
      [
        "<Callout>",
        "",
        "```mermaid",
        "flowchart LR",
        "  Draft --> Review",
        "```",
        "",
        "</Callout>",
      ].join("\n"),
    );

    expect(rendered.html).toContain('class="mermaid-block"');
    expect(rendered.html).toContain("data-mermaid-source");
    expect(rendered.html).toContain("Draft --> Review");
    expect(rendered.html).not.toContain("language-mermaid");
  });

  it("keeps ordinary indented code blocks as code", async () => {
    const rendered = await renderMarkdown("    export const ok = true;");

    expect(rendered.html).toContain("export const ok = true;");
    expect(rendered.html).toContain("<pre>");
    expect(rendered.html).not.toContain("vpg-code-block");
  });

  it("prefixes generated heading ids and strips global style/tabIndex allowances", async () => {
    const rendered = await renderMarkdown("# Login");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(rendered.html).toContain('id="user-content-login"');
    expect(rendered.html).toContain('href="#user-content-login"');
    expect(rendered.html).toContain('class="prose-heading-anchor"');
    expect(source).not.toContain('clobberPrefix: ""');
    expect(source).toContain('attribute !== "id"');
    expect(source).toContain('attribute !== "style"');
    expect(source).toContain('attribute !== "tabIndex"');
  });
});
