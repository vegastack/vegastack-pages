CREATE TABLE IF NOT EXISTS page_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE INDEX IF NOT EXISTS page_favorites_user_workspace_idx
  ON page_favorites(user_id, workspace_id, created_at);

CREATE INDEX IF NOT EXISTS page_favorites_page_idx
  ON page_favorites(page_id);
