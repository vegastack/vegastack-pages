CREATE TABLE IF NOT EXISTS search_documents (
  page_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  headings_text TEXT NOT NULL DEFAULT '',
  frontmatter_text TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
  page_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  path,
  headings_text,
  frontmatter_text,
  body_text,
  tags
);
