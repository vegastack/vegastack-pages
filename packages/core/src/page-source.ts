// Pure helpers for normalizing page source bodies before persistence.
//
// Pages have a `title` field on the row; rendered surfaces (the public
// /p/ view, the editor header, search snippets) all read it directly.
// When the body ALSO starts with `# {title}` (Markdown / MDX) or
// `<h1>{title}</h1>` (HTML), the title displays twice. Templates
// shipping `# {{ title }}` at the top, the web "new page" dialog
// seeding `# {title}` into the body, and CLI users habitually
// pasting the title as the first heading all produced this
// duplication. We strip a leading title-match on persist so the
// `title` field stays the single source of truth.
//
// The match is intentionally narrow: only the very first
// non-frontmatter, non-whitespace line, only if it normalizes to the
// same value as the page title. A different first heading
// ("# Introduction", "# Background") is left untouched.

import type { SourceType } from "./page-service";

function normalizeForCompare(value: string): string {
  return value
    .trim()
    .replace(/\s+#*$/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(source: string): FrontmatterSplit {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/.exec(source);
  if (!match) return { frontmatter: "", body: source };
  return {
    frontmatter: match[0],
    body: source.slice(match[0].length),
  };
}

function stripLeadingMarkdownH1(body: string, title: string): string {
  // Skip whitespace-only leading lines while preserving them on the
  // returned body if no match is found.
  const leadingWhitespace = /^[\t \r\n]*/u.exec(body)?.[0] ?? "";
  const afterWhitespace = body.slice(leadingWhitespace.length);
  const match = /^(#[ \t]+)([^\r\n]+?)([ \t#]*)(\r?\n(?:\r?\n)?|$)/u.exec(
    afterWhitespace,
  );
  if (!match) return body;
  if (normalizeForCompare(match[2]) !== normalizeForCompare(title)) {
    return body;
  }
  return afterWhitespace.slice(match[0].length);
}

function stripLeadingHtmlH1(body: string, title: string): string {
  // Match the very first <h1>…</h1> after optional whitespace. Tolerate
  // attributes but only strip when the inner text matches the title.
  // We do NOT strip non-standard wrappers (e.g. <h1><a>…</a></h1>)
  // to keep this conservative.
  const m = /^([\s]*)<h1\b[^>]*>([^<]*)<\/h1>\s*/iu.exec(body);
  if (!m) return body;
  if (normalizeForCompare(m[2]) !== normalizeForCompare(title)) {
    return body;
  }
  return body.slice(m[0].length);
}

export function stripLeadingTitleFromSource(
  source: string,
  title: string,
  sourceType: SourceType,
): string {
  if (!source) return source;
  const cleanTitle = title?.trim();
  if (!cleanTitle) return source;
  if (sourceType === "html") {
    return stripLeadingHtmlH1(source, cleanTitle);
  }
  // markdown + mdx share the same frontmatter / H1 conventions.
  const { frontmatter, body } = splitFrontmatter(source);
  const stripped = stripLeadingMarkdownH1(body, cleanTitle);
  if (stripped === body) return source;
  return `${frontmatter}${stripped}`;
}
