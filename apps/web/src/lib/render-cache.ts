import { flattenFrontmatter, renderMarkdown } from "@vegastack/pages-renderer";

type CachedRenderedMarkdown = Awaited<ReturnType<typeof renderMarkdown>> & {
  frontmatterText: string;
};

const maxEntries = 100;
const renderedMarkdownCache = new Map<string, CachedRenderedMarkdown>();

export async function renderCachedMarkdown(input: {
  pageId: string;
  contentHash: string;
  source: string;
}): Promise<CachedRenderedMarkdown> {
  const key = `${input.pageId}:${input.contentHash}`;
  const cached = renderedMarkdownCache.get(key);
  if (cached) {
    renderedMarkdownCache.delete(key);
    renderedMarkdownCache.set(key, cached);
    return cached;
  }

  const rendered = await renderMarkdown(input.source);
  const next = {
    ...rendered,
    frontmatterText: flattenFrontmatter(rendered.frontmatter),
  };
  renderedMarkdownCache.set(key, next);
  while (renderedMarkdownCache.size > maxEntries) {
    const oldestKey = renderedMarkdownCache.keys().next().value;
    if (!oldestKey) break;
    renderedMarkdownCache.delete(oldestKey);
  }
  return next;
}
