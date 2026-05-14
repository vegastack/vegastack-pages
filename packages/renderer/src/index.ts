import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import type { RehypeShikiOptions } from "@shikijs/rehype";
import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeOptions,
} from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  createHighlighter,
  createJavaScriptRegexEngine,
  type BundledLanguage,
  type ShikiTransformer,
} from "shiki";
import { unified } from "unified";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";

export type RenderHeading = {
  depth: number;
  href: string;
  htmlId: string;
  slug: string;
  text: string;
};

export type RenderedDocument = {
  html: string;
  frontmatter: Record<string, unknown>;
  headings: RenderHeading[];
  plainText: string;
};

type TextNode = { type: "text"; value: string };
type HeadingNode = {
  type: "heading";
  depth: number;
  children?: Array<TextNode | { children?: TextNode[] }>;
};
type CodeNode = { type: "code"; lang?: string; meta?: string; value: string };
type HastPropertyValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | Array<string | number>;
type HastElement = {
  type: "element";
  tagName: string;
  properties: Record<string, HastPropertyValue>;
  children: Array<HastElement | { type: "text"; value: string }>;
};
type ShikiPreNode = Parameters<NonNullable<ShikiTransformer["pre"]>>[0];
type ShikiChildNode = ShikiPreNode["children"][number];
type ShikiElementNode = Extract<ShikiChildNode, { type: "element" }>;
type RecoveredFence = {
  lang?: string;
  meta?: string;
  value: string;
};

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const clobberPrefix = "user-content-";
const safeGlobalAttributes = (defaultSchema.attributes?.["*"] ?? []).filter(
  (attribute) =>
    attribute !== "id" && attribute !== "style" && attribute !== "tabIndex",
);
const safeAnchorAttributes = (defaultSchema.attributes?.a ?? []).filter(
  (attribute) =>
    !(
      Array.isArray(attribute) &&
      (attribute[0] === "className" || attribute[0] === "class")
    ),
);

/**
 * Wrap every heading's children in an `<a class="prose-heading-anchor">`
 * pointing to its own `#slug`, so readers can click any heading to capture
 * a permalink. The hover-`#` affordance is styled in docs.css. We mark the
 * anchor with `data-anchor` so the sanitize step lets the attribute pass
 * and CSS can target it without colliding with body links.
 */
function rehypeHeadingAnchors() {
  return (tree: unknown) => {
    visit(tree as never, (node: HastElement) => {
      if (node.type !== "element") return;
      if (!HEADING_TAGS.has(node.tagName)) return;
      const id = (node.properties as { id?: string } | undefined)?.id;
      if (!id) return;
      const children = node.children ?? [];
      if (
        children.length === 1 &&
        children[0]?.type === "element" &&
        children[0].tagName === "a" &&
        (children[0].properties as { dataAnchor?: unknown } | undefined)
          ?.dataAnchor
      ) {
        return;
      }
      node.children = [
        {
          type: "element",
          tagName: "a",
          properties: {
            href: `#${clobberPrefix}${id}`,
            className: ["prose-heading-anchor"],
            dataAnchor: "true",
          },
          children,
        },
      ];
    });
  };
}

function rehypeMermaidBlocks() {
  return (tree: unknown) => {
    visit(tree as never, (node: HastElement) => {
      if (node.type !== "element" || node.tagName !== "pre") return;
      const code = node.children?.find(
        (child): child is HastElement =>
          child.type === "element" && child.tagName === "code",
      );
      if (!code) return;
      const className = code.properties.className;
      const classes = Array.isArray(className)
        ? className.map(String)
        : typeof className === "string"
          ? className.split(/\s+/)
          : [];
      if (!classes.includes("language-mermaid")) return;
      node.tagName = "div";
      node.properties = {
        className: ["mermaid-block"],
        dataMermaidSource: "true",
      };
      node.children = [{ type: "text", value: toString(code) }];
    });
  };
}

export function parseFrontmatter(source: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  if (!source.startsWith("---\n")) {
    return { frontmatter: {}, content: source };
  }

  const end = source.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: {}, content: source };
  }

  const yaml = source.slice(4, end);
  const afterFence = source.slice(end + 4).replace(/^\r?\n/, "");
  const parsed = parseYaml(yaml);
  return {
    frontmatter:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    content: afterFence,
  };
}

function slugifyHeading(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function textFromNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children))
    return node.children.map(textFromNode).join("");
  return "";
}

function collectMetadata() {
  const headings: RenderHeading[] = [];
  const plain: string[] = [];
  const seen = new Map<string, number>();

  return {
    headings,
    plain,
    plugin() {
      return (tree: unknown) => {
        visit(tree as never, (node: HeadingNode | CodeNode | TextNode) => {
          if (node.type === "heading") {
            const text = textFromNode(node).trim();
            const slug = slugifyHeading(text, seen);
            (
              node as HeadingNode & {
                data?: { hProperties?: Record<string, unknown> };
              }
            ).data = {
              hProperties: { id: slug },
            };
            const htmlId = `${clobberPrefix}${slug}`;
            headings.push({
              depth: node.depth,
              href: `#${htmlId}`,
              htmlId,
              slug,
              text,
            });
            plain.push(text);
          }
          if (node.type === "text") {
            plain.push(node.value);
          }
          if (node.type === "code") {
            plain.push(node.value);
          }
        });
      };
    },
  };
}

function recoverIndentedFence(value: string): RecoveredFence | null {
  const lines = value.split(/\r?\n/);
  const openerIndex = lines.findIndex((line) => line.trim() !== "");
  if (openerIndex < 0) return null;
  if (lines.slice(0, openerIndex).some((line) => line.trim() !== "")) {
    return null;
  }

  const opener = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[openerIndex]);
  if (!opener) return null;

  const fence = opener[2];
  const fenceChar = fence[0];
  const fenceLength = fence.length;
  const info = opener[3].trim();
  if (fenceChar === "`" && info.includes("`")) return null;

  const isClosingFence = (line: string) => {
    const leadingSpaces = /^( {0,3})/.exec(line)?.[1].length ?? 0;
    const rest = line.slice(leadingSpaces);
    let fenceChars = 0;
    while (rest[fenceChars] === fenceChar) fenceChars += 1;
    return fenceChars >= fenceLength && rest.slice(fenceChars).trim() === "";
  };

  const closingIndex = lines.findIndex(
    (line, index) => index > openerIndex && isClosingFence(line),
  );
  if (closingIndex < 0) return null;
  if (lines.slice(closingIndex + 1).some((line) => line.trim() !== "")) {
    return null;
  }

  const firstInfoSpace = info.search(/\s/);
  const lang =
    firstInfoSpace < 0 ? info || undefined : info.slice(0, firstInfoSpace);
  const meta =
    firstInfoSpace < 0 ? undefined : info.slice(firstInfoSpace).trim();

  return {
    lang,
    meta: meta || undefined,
    value: lines.slice(openerIndex + 1, closingIndex).join("\n"),
  };
}

function remarkRecoverIndentedFences() {
  return (tree: unknown) => {
    visit(tree as never, (node: CodeNode) => {
      if (node.type !== "code" || node.lang) return;
      const recovered = recoverIndentedFence(node.value);
      if (!recovered) return;
      node.lang = recovered.lang;
      node.meta = recovered.meta;
      node.value = recovered.value;
    });
  };
}

const sanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  clobberPrefix,
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...safeGlobalAttributes,
      "className",
      "dataLanguage",
      ["data-language"],
      ["data-meta"],
      ["data-anchor"],
      "dataMermaidSource",
      ["data-mermaid-source"],
    ],
    h1: [...(defaultSchema.attributes?.h1 ?? []), "id"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
    h3: [...(defaultSchema.attributes?.h3 ?? []), "id"],
    h4: [...(defaultSchema.attributes?.h4 ?? []), "id"],
    h5: [...(defaultSchema.attributes?.h5 ?? []), "id"],
    h6: [...(defaultSchema.attributes?.h6 ?? []), "id"],
    a: [
      ...safeAnchorAttributes,
      ["className", "prose-heading-anchor"],
      ["data-anchor"],
    ],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      "className",
      "dataLanguage",
      "style",
      ["data-language"],
      ["data-meta"],
    ],
    pre: [
      ...(defaultSchema.attributes?.pre ?? []),
      "className",
      "dataLanguage",
      "style",
      ["data-language"],
      ["data-meta"],
    ],
    span: ["className", "style"],
  },
};

// Shiki transformer that stamps our `vpg-code-block` class and
// `data-language` attribute onto the rendered <pre> (and <code>) so the
// client-side prose enhancements can attach the copy button. Runs as part of
// the Shiki pass; replaces the old standalone `codeBlockMetadata` plugin,
// which broke after Shiki started replacing the <pre>/<code> subtree.
function vpgCodeBlockTransformer(): ShikiTransformer {
  return {
    name: "vpg-code-block",
    pre(node) {
      const lang = this.options?.lang;
      const existing = Array.isArray(node.properties?.className)
        ? (node.properties.className as unknown[]).map(String)
        : typeof node.properties?.className === "string"
          ? (node.properties.className as string).split(/\s+/)
          : [];
      const className = [...new Set(["shiki", ...existing, "vpg-code-block"])];
      node.properties = {
        ...(node.properties ?? {}),
        className,
      };
      if (lang) {
        (node.properties as Record<string, unknown>).dataLanguage = lang;
      }
      const code = node.children?.find(
        (child): child is ShikiElementNode =>
          child.type === "element" && child.tagName === "code",
      );
      if (code && lang) {
        code.properties = {
          ...(code.properties ?? {}),
          dataLanguage: lang,
        };
      }
    },
  };
}

// Match the Shiki config Astro uses for /docs (apps/web/astro.config.mjs)
// so app pages and docs pages render code with identical token colors and
// dual-theme CSS variables.
const SHIKI_THEMES = {
  light: "github-light",
  dark: "github-dark-dimmed",
} as const;

const SHIKI_LANGUAGES = [
  "markdown",
  "md",
  "mdx",
  "javascript",
  "js",
  "typescript",
  "ts",
  "jsx",
  "tsx",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "html",
  "css",
  "scss",
  "bash",
  "shell",
  "sh",
  "zsh",
  "python",
  "py",
  "go",
  "rust",
  "rs",
  "sql",
  "mermaid",
] satisfies BundledLanguage[];

const shikiHighlighter = createHighlighter({
  themes: Object.values(SHIKI_THEMES),
  langs: SHIKI_LANGUAGES,
  engine: createJavaScriptRegexEngine(),
});

const shikiOptions: RehypeShikiOptions = {
  themes: SHIKI_THEMES,
  defaultColor: false,
  fallbackLanguage: "text",
  transformers: [vpgCodeBlockTransformer()],
};

export async function renderMarkdown(
  source: string,
): Promise<RenderedDocument> {
  const parsed = parseFrontmatter(source);
  const metadata = collectMetadata();
  const highlighter = await shikiHighlighter;
  const file = await unified()
    .use(remarkParse)
    .use(remarkRecoverIndentedFences)
    .use(remarkGfm)
    .use(metadata.plugin)
    .use(remarkRehype)
    .use(rehypeHeadingAnchors)
    .use(rehypeMermaidBlocks)
    .use(() => rehypeShikiFromHighlighter(highlighter, shikiOptions))
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify)
    .process(parsed.content);

  return {
    html: String(file),
    frontmatter: parsed.frontmatter,
    headings: metadata.headings,
    plainText: metadata.plain.join("\n"),
  };
}

export function flattenFrontmatter(
  frontmatter: Record<string, unknown>,
): string {
  return Object.entries(frontmatter)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join("\n");
}
