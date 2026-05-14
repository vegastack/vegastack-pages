-- Drop the redundant denormalization on agent_sessions. The oauth_client_id FK
-- already resolves to oauth_clients.redirect_uris_json when needed. The column
-- was only ever written, never read.
ALTER TABLE agent_sessions DROP COLUMN redirect_uris_json;

-- Merge the two transient-state tables (oauth_auth_codes and oauth_device_codes)
-- into a single oauth_grants table. Both tables held short-lived (60s / 10min)
-- OAuth flow state with 80% column overlap. A single table means one sweep
-- function, one set of indexes, and one place to reason about TTLs.
--
-- Per-kind required fields are enforced with a CHECK so the type discipline
-- doesn't drop with the column count.
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

-- Drop the now-unused transient tables. In-flight flows (an unconsumed auth code
-- mid-redemption or a device code being polled) are dropped during the migration
-- window; both clients retry naturally — the loss is bounded by the 60s/10min
-- TTLs that already governed those rows.
DROP TABLE IF EXISTS oauth_auth_codes;
DROP TABLE IF EXISTS oauth_device_codes;
