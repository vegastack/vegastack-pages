CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_events_workspace_idx ON review_events(workspace_id);
CREATE INDEX IF NOT EXISTS review_events_page_idx ON review_events(page_id);

CREATE TABLE IF NOT EXISTS setup_state (
  key TEXT PRIMARY KEY NOT NULL,
  setup_complete INTEGER NOT NULL DEFAULT 0,
  first_admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  first_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
