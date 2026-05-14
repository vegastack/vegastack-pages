CREATE TABLE IF NOT EXISTS workspace_templates (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  source_type TEXT NOT NULL DEFAULT 'markdown' CHECK (source_type IN ('markdown', 'mdx')),
  object_key_current TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version_id TEXT NOT NULL,
  properties_json TEXT NOT NULL DEFAULT '[]',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_templates_slug_unique ON workspace_templates(workspace_id, slug);
CREATE INDEX IF NOT EXISTS workspace_templates_workspace_idx ON workspace_templates(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_template_versions (
  id TEXT PRIMARY KEY NOT NULL,
  template_id TEXT NOT NULL REFERENCES workspace_templates(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'mdx')),
  properties_json TEXT NOT NULL DEFAULT '[]',
  label TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_template_versions_template_idx ON workspace_template_versions(template_id);
