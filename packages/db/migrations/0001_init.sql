-- VegaStack Pages canonical schema.
-- Single squashed migration. All prior 0001-0021 migrations are folded here.
-- SQLite (D1) compatible: TEXT + CHECK in place of enums, no GENERATED cols.

PRAGMA foreign_keys = ON;

------------------------------------------------------------------------------
-- Users + auth
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'instance_admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('email', 'google')),
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_subject_unique
  ON auth_identities(provider, provider_subject);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  redirect_to TEXT NOT NULL DEFAULT '/',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS magic_links_token_hash_unique
  ON magic_links(token_hash);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links(email);
CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links(expires_at);

------------------------------------------------------------------------------
-- Workspaces, members, permissions
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version_retention_days INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_unique ON workspaces(slug);

CREATE TABLE IF NOT EXISTS workspace_members (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader', 'commenter', 'editor', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_user_unique
  ON workspace_members(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user')),
  subject_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'folder', 'page')),
  target_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('none', 'read', 'comment', 'write', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_subject_scope_unique
  ON permissions(workspace_id, subject_type, subject_id, scope, target_id);
CREATE INDEX IF NOT EXISTS permissions_workspace_subject_idx
  ON permissions(workspace_id, subject_id);

------------------------------------------------------------------------------
-- Content tree: folders, pages, page_versions, page_favorites
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_id TEXT NOT NULL,
  path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_slug_id_unique ON folders(slug_id);
CREATE INDEX IF NOT EXISTS folders_workspace_parent_position_idx
  ON folders(workspace_id, parent_folder_id, position);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'mdx', 'html')),
  object_key_current TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(frontmatter_json)),
  content_hash TEXT NOT NULL,
  version_id TEXT,
  position INTEGER NOT NULL DEFAULT 1,
  has_code INTEGER NOT NULL DEFAULT 0,
  has_mermaid INTEGER NOT NULL DEFAULT 0,
  has_math INTEGER NOT NULL DEFAULT 0,
  has_wardley INTEGER NOT NULL DEFAULT 0,
  has_cytoscape INTEGER NOT NULL DEFAULT 0,
  has_iframe INTEGER NOT NULL DEFAULT 0,
  rendered_artifact_key TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_slug_id_unique ON pages(slug_id);
CREATE INDEX IF NOT EXISTS pages_workspace_folder_position_idx
  ON pages(workspace_id, folder_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pages_workspace_updated_idx
  ON pages(workspace_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pages_workspace_deleted_idx
  ON pages(workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS page_versions (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'mdx', 'html')),
  label TEXT,
  created_reason TEXT NOT NULL
    CHECK (created_reason IN ('manual', 'time_checkpoint', 'share_milestone', 'system')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_versions_page_created_idx
  ON page_versions(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS page_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, page_id)
);
CREATE INDEX IF NOT EXISTS page_favorites_user_workspace_idx
  ON page_favorites(user_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS page_favorites_page_idx ON page_favorites(page_id);

------------------------------------------------------------------------------
-- Templates
------------------------------------------------------------------------------

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
  properties_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(properties_json)),
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_templates_slug_unique
  ON workspace_templates(workspace_id, slug);
CREATE INDEX IF NOT EXISTS workspace_templates_workspace_category_idx
  ON workspace_templates(workspace_id, category, name);

CREATE TABLE IF NOT EXISTS workspace_template_versions (
  id TEXT PRIMARY KEY NOT NULL,
  template_id TEXT NOT NULL REFERENCES workspace_templates(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'mdx')),
  properties_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(properties_json)),
  label TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_template_versions_template_idx
  ON workspace_template_versions(template_id);

------------------------------------------------------------------------------
-- Comments
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comment_threads (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  selected_text TEXT NOT NULL,
  guest_name TEXT,
  guest_session_id TEXT,
  publication_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comment_threads_page_status_created_idx
  ON comment_threads(page_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS comment_threads_publication_idx
  ON comment_threads(publication_id) WHERE publication_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS comment_anchors (
  thread_id TEXT PRIMARY KEY NOT NULL
    REFERENCES comment_threads(id) ON DELETE CASCADE,
  source_start INTEGER,
  source_end INTEGER,
  rendered_dom_path TEXT,
  selected_text TEXT NOT NULL,
  prefix_text TEXT NOT NULL,
  suffix_text TEXT NOT NULL,
  content_hash_at_creation TEXT NOT NULL,
  anchor_kind TEXT NOT NULL DEFAULT 'text'
    CHECK (anchor_kind IN ('text', 'point')),
  surface TEXT NOT NULL DEFAULT 'prose'
    CHECK (surface IN ('prose', 'html')),
  selector_json TEXT CHECK (selector_json IS NULL OR json_valid(selector_json)),
  confidence TEXT NOT NULL DEFAULT 'active'
    CHECK (confidence IN ('active', 'reanchored', 'fuzzy', 'manual', 'stale'))
);

CREATE TABLE IF NOT EXISTS comment_replies (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'guest', 'agent')),
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  guest_name TEXT,
  guest_session_id TEXT,
  publication_id TEXT,
  agent_name TEXT,
  agent_model TEXT,
  agent_session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comment_replies_thread_created_idx
  ON comment_replies(thread_id, created_at);

------------------------------------------------------------------------------
-- Publications
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'folder')),
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view'
    CHECK (permission IN ('view', 'comment', 'edit')),
  expires_at TEXT,
  password_hash TEXT,
  indexing_enabled INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  latest_artifact_key TEXT,
  latest_content_hash TEXT,
  latest_rendered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS publications_resource_unique
  ON publications(workspace_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS publications_resource_lookup_idx
  ON publications(resource_type, resource_id);

------------------------------------------------------------------------------
-- Attachments
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  image_width INTEGER,
  image_height INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_page_idx ON attachments(page_id);
CREATE INDEX IF NOT EXISTS attachments_workspace_idx ON attachments(workspace_id);

------------------------------------------------------------------------------
-- Audit + review
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_workspace_created_idx
  ON audit_logs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_events_workspace_created_idx
  ON review_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS review_events_page_idx ON review_events(page_id);

------------------------------------------------------------------------------
-- Search (composite PK; FTS5 mirrored via triggers)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS search_documents (
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('page', 'folder', 'comment_thread')),
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
  ON search_documents(workspace_id, resource_type, updated_at DESC);

-- FTS5 virtual mirror. search_documents has a composite PK and no integer
-- rowid we can pin to, so we use a contentless-style mirror kept in sync by
-- triggers below. Column list matches 0013.
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

CREATE TRIGGER IF NOT EXISTS search_documents_ai
AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts (
    resource_type, resource_id, workspace_id, page_id, folder_id,
    title, path, headings_text, frontmatter_text, body_text, comment_text, tags
  ) VALUES (
    NEW.resource_type, NEW.resource_id, NEW.workspace_id, NEW.page_id, NEW.folder_id,
    NEW.title, NEW.path, NEW.headings_text, NEW.frontmatter_text,
    NEW.body_text, NEW.comment_text, NEW.tags
  );
END;

CREATE TRIGGER IF NOT EXISTS search_documents_ad
AFTER DELETE ON search_documents BEGIN
  DELETE FROM search_documents_fts
   WHERE resource_type = OLD.resource_type
     AND resource_id = OLD.resource_id;
END;

CREATE TRIGGER IF NOT EXISTS search_documents_au
AFTER UPDATE ON search_documents BEGIN
  DELETE FROM search_documents_fts
   WHERE resource_type = OLD.resource_type
     AND resource_id = OLD.resource_id;
  INSERT INTO search_documents_fts (
    resource_type, resource_id, workspace_id, page_id, folder_id,
    title, path, headings_text, frontmatter_text, body_text, comment_text, tags
  ) VALUES (
    NEW.resource_type, NEW.resource_id, NEW.workspace_id, NEW.page_id, NEW.folder_id,
    NEW.title, NEW.path, NEW.headings_text, NEW.frontmatter_text,
    NEW.body_text, NEW.comment_text, NEW.tags
  );
END;

CREATE TABLE IF NOT EXISTS search_recent_resources (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('page', 'folder', 'comment_thread')),
  resource_id TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS search_recent_resources_user_workspace_idx
  ON search_recent_resources(user_id, workspace_id, last_opened_at DESC);

------------------------------------------------------------------------------
-- Setup + rate limits
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS setup_state (
  key TEXT PRIMARY KEY NOT NULL,
  setup_complete INTEGER NOT NULL DEFAULT 0,
  first_admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  first_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  reset_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits(reset_at);

------------------------------------------------------------------------------
-- Agent / MCP sessions
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL CHECK (json_valid(redirect_uris_json)),
  software_id TEXT,
  software_version TEXT,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  registered_user_agent TEXT,
  registered_ip TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_clients_client_name_idx
  ON oauth_clients(client_name);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_version TEXT,
  model TEXT,
  kind TEXT NOT NULL DEFAULT 'manual',
  user_agent TEXT,
  last_origin TEXT,
  oauth_client_id TEXT REFERENCES oauth_clients(id) ON DELETE SET NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_workspace_user_idx
  ON agent_sessions(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS agent_sessions_kind_idx ON agent_sessions(kind);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  protocol_version TEXT,
  refresh_token_hash TEXT,
  refresh_token_expires_at TEXT,
  -- previous_refresh_token_hash tracks the previous refresh token after
  -- a rotation. Used by replay detection: if a client redeems the OLD
  -- hash after rotation succeeded, the entire session chain is revoked
  -- (RFC 6749 §10.4 refresh-token-rotation hygiene).
  previous_refresh_token_hash TEXT,
  scope TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_sessions_workspace_user_idx
  ON mcp_sessions(workspace_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_sessions_refresh_hash_unique
  ON mcp_sessions(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_sessions_previous_refresh_hash_idx
  ON mcp_sessions(previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;

------------------------------------------------------------------------------
-- OAuth grants (merged auth_codes + device_codes, per 0019)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_grants (
  code_hash TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auth_code', 'device_code')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT,
  redirect_uri TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  user_code TEXT,
  last_polled_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (kind = 'auth_code'
      AND redirect_uri IS NOT NULL
      AND code_challenge IS NOT NULL
      AND code_challenge_method = 'S256'
      AND user_id IS NOT NULL
      AND workspace_id IS NOT NULL
      AND user_code IS NULL)
    OR (kind = 'device_code'
      AND user_code IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS oauth_grants_expires_idx ON oauth_grants(expires_at);
CREATE INDEX IF NOT EXISTS oauth_grants_kind_status_idx
  ON oauth_grants(kind, status);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_user_code_unique
  ON oauth_grants(user_code) WHERE user_code IS NOT NULL;

------------------------------------------------------------------------------
-- GitHub sync
------------------------------------------------------------------------------

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
  last_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (last_status IN ('pending', 'success', 'failed', 'idle')),
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
  connection_id TEXT NOT NULL
    REFERENCES github_sync_connections(id) ON DELETE CASCADE,
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
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
);
CREATE INDEX IF NOT EXISTS github_sync_runs_connection_idx
  ON github_sync_runs(connection_id, started_at DESC);
CREATE INDEX IF NOT EXISTS github_sync_runs_workspace_idx
  ON github_sync_runs(workspace_id);

------------------------------------------------------------------------------
-- Migration ledger (declared here, not lazily by app code)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);
