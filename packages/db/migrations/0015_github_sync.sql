CREATE TABLE IF NOT EXISTS github_sync_connections (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  repo_id INTEGER,
  branch TEXT,
  root_path TEXT NOT NULL DEFAULT 'docs',
  include_assets INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('pending', 'success', 'failed', 'idle')),
  last_synced_at TEXT,
  last_commit_sha TEXT,
  last_error TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS github_sync_connections_workspace_unique
  ON github_sync_connections(workspace_id);
CREATE INDEX IF NOT EXISTS github_sync_connections_installation_idx
  ON github_sync_connections(installation_id);

CREATE TABLE IF NOT EXISTS github_sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES github_sync_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  base_commit_sha TEXT,
  head_commit_sha TEXT,
  pages_written INTEGER NOT NULL DEFAULT 0,
  templates_written INTEGER NOT NULL DEFAULT 0,
  assets_written INTEGER NOT NULL DEFAULT 0,
  files_deleted INTEGER NOT NULL DEFAULT 0,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS github_sync_runs_connection_idx
  ON github_sync_runs(connection_id, started_at);
CREATE INDEX IF NOT EXISTS github_sync_runs_workspace_idx
  ON github_sync_runs(workspace_id);
