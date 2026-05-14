CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  software_id TEXT,
  software_version TEXT,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  registered_user_agent TEXT,
  registered_ip TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_clients_client_name_idx ON oauth_clients(client_name);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  consumed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx ON oauth_auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_device_codes (
  device_code_hash TEXT PRIMARY KEY NOT NULL,
  user_code TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  last_polled_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_device_codes_user_code_unique ON oauth_device_codes(user_code);
CREATE INDEX IF NOT EXISTS oauth_device_codes_expires_idx ON oauth_device_codes(expires_at);

ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE agent_sessions ADD COLUMN redirect_uris_json TEXT;
ALTER TABLE agent_sessions ADD COLUMN user_agent TEXT;
ALTER TABLE agent_sessions ADD COLUMN last_origin TEXT;
ALTER TABLE agent_sessions ADD COLUMN oauth_client_id TEXT REFERENCES oauth_clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agent_sessions_kind_idx ON agent_sessions(kind);

ALTER TABLE mcp_sessions ADD COLUMN refresh_token_hash TEXT;
ALTER TABLE mcp_sessions ADD COLUMN refresh_token_expires_at TEXT;
ALTER TABLE mcp_sessions ADD COLUMN scope TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS mcp_sessions_refresh_hash_unique ON mcp_sessions(refresh_token_hash);
