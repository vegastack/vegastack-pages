DROP TABLE IF EXISTS search_documents_fts;
DROP TABLE IF EXISTS search_documents;

CREATE TABLE IF NOT EXISTS search_documents (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'folder', 'comment_thread')),
  resource_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  headings_text TEXT NOT NULL DEFAULT '',
  frontmatter_text TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  comment_text TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS search_documents_workspace_idx
  ON search_documents(workspace_id, resource_type, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
  resource_type UNINDEXED,
  resource_id UNINDEXED,
  workspace_id UNINDEXED,
  page_id UNINDEXED,
  folder_id UNINDEXED,
  title,
  path,
  headings_text,
  frontmatter_text,
  body_text,
  comment_text,
  tags
);

CREATE TABLE IF NOT EXISTS search_recent_resources (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'folder', 'comment_thread')),
  resource_id TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS search_recent_resources_user_workspace_idx
  ON search_recent_resources(user_id, workspace_id, last_opened_at);
