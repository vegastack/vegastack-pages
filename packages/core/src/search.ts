export type SearchResourceType = "page" | "folder" | "comment_thread";

export type SearchDocument = {
  id: string;
  type: SearchResourceType;
  workspaceId: string;
  pageId?: string | null;
  folderId?: string | null;
  title: string;
  path: string;
  headingsText?: string;
  frontmatterText?: string;
  bodyText?: string;
  commentText?: string;
  tags?: string;
  url: string;
  updatedAt: string;
};

export type SearchResult = {
  type: SearchResourceType;
  id: string;
  pageId: string | null;
  folderId: string | null;
  title: string;
  url: string;
  path: string;
  subtitle: string;
  snippet: string;
  updatedAt: string;
  icon: "file-text" | "folder" | "message-square";
  matchedField: "title" | "path" | "content" | "comment";
  score: number;
};

export type SearchOptions = {
  limit?: number;
  type?: SearchResourceType | "all";
  favoritePageIds?: Set<string>;
  recentResourceIds?: Set<string>;
};

export class SearchService {
  private readonly documents = new Map<string, SearchDocument>();

  index(document: SearchDocument): void {
    this.documents.set(searchDocumentKey(document.type, document.id), document);
  }

  remove(type: SearchResourceType, id: string): void {
    this.documents.delete(searchDocumentKey(type, id));
  }

  search(
    workspaceId: string,
    query: string,
    optionsOrLimit: SearchOptions | number = {},
  ): SearchResult[] {
    const options =
      typeof optionsOrLimit === "number"
        ? { limit: optionsOrLimit }
        : optionsOrLimit;
    const limit = options.limit ?? 10;
    const type = options.type ?? "all";
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const tokens = normalized.split(/\s+/).filter(Boolean);

    return [...this.documents.values()]
      .filter((document) => document.workspaceId === workspaceId)
      .filter((document) => type === "all" || document.type === type)
      .map((document) => {
        const match = scoreDocument(document, normalized, tokens, options);
        return { document, match };
      })
      .filter((item) => item.match.score > 0)
      .sort(
        (left, right) =>
          right.match.score - left.match.score ||
          right.document.updatedAt.localeCompare(left.document.updatedAt) ||
          left.document.title.localeCompare(right.document.title),
      )
      .slice(0, limit)
      .map(({ document, match }) =>
        toSearchResult(document, normalized, match),
      );
  }
}

function searchDocumentKey(type: SearchResourceType, id: string) {
  return `${type}:${id}`;
}

function scoreDocument(
  document: SearchDocument,
  query: string,
  tokens: string[],
  options: SearchOptions,
) {
  const fields: Array<{
    field: SearchResult["matchedField"];
    text: string;
    exactWeight: number;
    tokenWeight: number;
  }> = [
    { field: "title", text: document.title, exactWeight: 120, tokenWeight: 28 },
    { field: "path", text: document.path, exactWeight: 80, tokenWeight: 18 },
    {
      field: "content",
      text: [
        document.headingsText ?? "",
        document.frontmatterText ?? "",
        document.bodyText ?? "",
        document.tags ?? "",
      ].join("\n"),
      exactWeight: 55,
      tokenWeight: 10,
    },
    {
      field: "comment",
      text: document.commentText ?? "",
      exactWeight: 60,
      tokenWeight: 12,
    },
  ];

  let bestField: SearchResult["matchedField"] = "content";
  let score = 0;
  let matchedTokens = 0;

  for (const candidate of fields) {
    const lower = candidate.text.toLowerCase();
    if (!lower) continue;
    const exactIndex = lower.indexOf(query);
    if (exactIndex >= 0) {
      score += candidate.exactWeight + Math.max(0, 30 - exactIndex);
      bestField = candidate.field;
    }
    for (const token of tokens) {
      if (lower.includes(token)) {
        matchedTokens += 1;
        score += candidate.tokenWeight;
        bestField = candidate.field;
      } else if (fuzzyContains(lower, token)) {
        matchedTokens += 1;
        score += Math.max(3, Math.floor(candidate.tokenWeight / 2));
        bestField = candidate.field;
      }
    }
  }

  if (tokens.length > 0 && matchedTokens < tokens.length) score = 0;
  if (score <= 0) return { score: 0, matchedField: bestField };
  if (document.type === "folder") score += 8;
  if (document.type === "page") score += 5;
  if (document.pageId && options.favoritePageIds?.has(document.pageId)) {
    score += 18;
  }
  if (
    options.recentResourceIds?.has(
      searchDocumentKey(document.type, document.id),
    )
  ) {
    score += 20;
  }
  score += recencyBoost(document.updatedAt);

  return { score, matchedField: bestField };
}

function recencyBoost(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = (Date.now() - timestamp) / 86_400_000;
  if (ageDays <= 1) return 12;
  if (ageDays <= 7) return 8;
  if (ageDays <= 30) return 4;
  return 0;
}

function fuzzyContains(text: string, token: string) {
  if (token.length < 4) return false;
  return text
    .split(/[^a-z0-9_/-]+/i)
    .filter((part) => part.length >= Math.max(3, token.length - 1))
    .some((part) => levenshteinAtMost(part, token, token.length <= 6 ? 1 : 2));
}

function levenshteinAtMost(left: string, right: string, maxDistance: number) {
  if (Math.abs(left.length - right.length) > maxDistance) return false;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  const current = new Array<number>(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > maxDistance) return false;
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] <= maxDistance;
}

function toSearchResult(
  document: SearchDocument,
  query: string,
  match: { score: number; matchedField: SearchResult["matchedField"] },
): SearchResult {
  return {
    type: document.type,
    id: document.id,
    pageId: document.pageId ?? (document.type === "page" ? document.id : null),
    folderId:
      document.folderId ?? (document.type === "folder" ? document.id : null),
    title: document.title,
    url: document.url,
    path: document.path,
    subtitle: document.path || document.title,
    snippet: createSnippet(document, query, match.matchedField),
    updatedAt: document.updatedAt,
    icon:
      document.type === "folder"
        ? "folder"
        : document.type === "comment_thread"
          ? "message-square"
          : "file-text",
    matchedField: match.matchedField,
    score: match.score,
  };
}

function createSnippet(
  document: SearchDocument,
  query: string,
  matchedField: SearchResult["matchedField"],
): string {
  const text =
    matchedField === "comment"
      ? (document.commentText ?? "")
      : matchedField === "path"
        ? document.path
        : [document.title, document.headingsText, document.bodyText].join(" ");
  const lower = text.toLowerCase();
  const index = lower.indexOf(query);
  if (index < 0) return text.slice(0, 160);
  return text
    .slice(
      Math.max(0, index - 60),
      Math.min(text.length, index + query.length + 100),
    )
    .trim();
}
