PRAGMA foreign_keys = ON;

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
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_subject_unique ON auth_identities(provider, provider_subject);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  redirect_to TEXT NOT NULL DEFAULT '/',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS magic_links_token_hash_unique ON magic_links(token_hash);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links(email);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_user_unique ON workspace_members(workspace_id, user_id);
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
CREATE INDEX IF NOT EXISTS permissions_workspace_subject_idx ON permissions(workspace_id, subject_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_folder_id TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_id TEXT NOT NULL,
  path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_slug_id_unique ON folders(slug_id);
CREATE INDEX IF NOT EXISTS folders_workspace_parent_idx ON folders(workspace_id, parent_folder_id);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'mdx', 'html')),
  object_key_current TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  render_cache_key TEXT,
  position INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_slug_id_unique ON pages(slug_id);
CREATE INDEX IF NOT EXISTS pages_workspace_folder_idx ON pages(workspace_id, folder_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_page_idx ON attachments(page_id);
CREATE INDEX IF NOT EXISTS attachments_workspace_idx ON attachments(workspace_id);

CREATE TABLE IF NOT EXISTS page_versions (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'mdx', 'html')),
  label TEXT,
  created_reason TEXT NOT NULL CHECK (created_reason IN ('manual', 'time_checkpoint', 'share_milestone', 'system')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_versions_page_idx ON page_versions(page_id);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_version TEXT,
  model TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_workspace_user_idx ON agent_sessions(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  protocol_version TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_sessions_workspace_user_idx ON mcp_sessions(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_workspace_status_idx ON jobs(workspace_id, status);

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
CREATE INDEX IF NOT EXISTS comment_threads_page_status_idx ON comment_threads(page_id, status);

CREATE TABLE IF NOT EXISTS comment_anchors (
  thread_id TEXT PRIMARY KEY NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  source_start INTEGER,
  source_end INTEGER,
  rendered_dom_path TEXT,
  selected_text TEXT NOT NULL,
  prefix_text TEXT NOT NULL,
  suffix_text TEXT NOT NULL,
  content_hash_at_creation TEXT NOT NULL,
  reanchor_status TEXT NOT NULL DEFAULT 'active' CHECK (reanchor_status IN ('active', 'reanchored', 'stale'))
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
CREATE INDEX IF NOT EXISTS comment_replies_thread_idx ON comment_replies(thread_id);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'folder')),
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'comment', 'edit')),
  expires_at TEXT,
  password_hash TEXT,
  indexing_enabled INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS publications_resource_unique
  ON publications(workspace_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS publications_workspace_idx ON publications(workspace_id);

CREATE TABLE IF NOT EXISTS search_documents (
  page_id TEXT PRIMARY KEY NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  headings_text TEXT NOT NULL DEFAULT '',
  frontmatter_text TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_documents_workspace_idx ON search_documents(workspace_id);

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

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_workspace_idx ON audit_logs(workspace_id);

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
