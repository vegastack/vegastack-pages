// Save-time render pipeline tests (Plan 011 §6 / Plan 012 Phase E).
// Verifies that renderAtSave produces sanitized HTML, the has_* flag
// scan matches the source content, and the three source-type pipelines
// (markdown / mdx / html) each behave per spec.

import { describe, expect, it } from "vitest";
import { renderAtSave, renderHtmlSource } from "../index";

describe("renderAtSave — markdown", () => {
  it("renders a basic markdown doc with sanitize + flag detection", async () => {
    const result = await renderAtSave({
      sourceType: "markdown",
      source: `# Title\n\nSome text.\n`,
    });
    expect(result.html).toContain("<h1");
    expect(result.html).toContain("Title");
    expect(result.hasCode).toBe(false);
    expect(result.hasMermaid).toBe(false);
    expect(result.hasMath).toBe(false);
  });

  it("detects code fences and emits shiki-classed <pre>", async () => {
    const result = await renderAtSave({
      sourceType: "markdown",
      source: "```ts\nexport const x = 1;\n```\n",
    });
    expect(result.hasCode).toBe(true);
    expect(result.html).toContain('class="shiki');
    expect(result.html).toContain('data-language="ts"');
  });

  it("preserves mermaid blocks for client-side rendering", async () => {
    const result = await renderAtSave({
      sourceType: "markdown",
      source: "```mermaid\ngraph TD; A-->B\n```\n",
    });
    expect(result.hasMermaid).toBe(true);
    expect(result.hasCode).toBe(true);
    expect(result.html).toContain("mermaid-block");
    expect(result.html).toContain("data-mermaid-source");
  });

  it("detects math notation in the source", async () => {
    const result = await renderAtSave({
      sourceType: "markdown",
      source: "Inline $a^2 + b^2 = c^2$ and $$\\int x dx$$.\n",
    });
    expect(result.hasMath).toBe(true);
  });

  it("strips malicious <script> and on* attributes via rehype-sanitize", async () => {
    const result = await renderAtSave({
      sourceType: "markdown",
      source:
        '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<a href="javascript:alert(1)">Click</a>\n',
    });
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("onerror");
    expect(result.html).not.toContain("javascript:");
  });

  it("emits frontmatter + headings metadata", async () => {
    const result = await renderAtSave({
      sourceType: "markdown",
      source: `---\ntitle: Hello\ntags: [a, b]\n---\n\n## Section\n`,
    });
    expect(result.frontmatter.title).toBe("Hello");
    expect(result.headings.length).toBe(1);
    expect(result.headings[0]!.depth).toBe(2);
    expect(result.headings[0]!.text).toBe("Section");
  });

  it("includes inline `code` and fenced code text in plainText for FTS", async () => {
    // Without this, function names, env vars, and identifiers wrapped in
    // backticks are unfindable in search. Discovered live: searching for
    // `kangaroo` after saving a page with `` `kangaroo` `` returned zero
    // hits even though the page rendered correctly.
    const result = await renderAtSave({
      sourceType: "markdown",
      source:
        "# Heading\n\nProse with `inlineKangaroo` token.\n\n```ts\nconst fencedZebra = 1;\n```\n",
    });
    expect(result.plainText).toContain("Heading");
    expect(result.plainText).toContain("Prose with");
    expect(result.plainText).toContain("inlineKangaroo");
    expect(result.plainText).toContain("fencedZebra");
  });
});

describe("renderAtSave — html", () => {
  it("sanitizes a raw-html source", async () => {
    const result = await renderAtSave({
      sourceType: "html",
      source: '<p>ok</p><script>alert(1)</script><div onclick="x()">bad</div>',
    });
    expect(result.html).toContain("<p>ok</p>");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("onclick");
  });

  it("detects <iframe> as has_iframe", async () => {
    const result = await renderAtSave({
      sourceType: "html",
      source: '<iframe src="https://example.test"></iframe>',
    });
    expect(result.hasIframe).toBe(true);
  });
});

describe("renderHtmlSource", () => {
  it("returns sanitized HTML for inline use", async () => {
    const html = await renderHtmlSource("<p>x</p><script>y</script>");
    expect(html).toContain("<p>x</p>");
    expect(html).not.toContain("<script");
  });
});

describe("renderAtSave — mdx", () => {
  it("falls back to markdown rendering for MDX source (allowlist deferred)", async () => {
    const result = await renderAtSave({
      sourceType: "mdx",
      source: "# Hello\n\nPlain markdown only for now.\n",
    });
    expect(result.html).toContain("<h1");
    expect(result.html).toContain("Hello");
  });
});
