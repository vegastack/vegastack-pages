-- Well-known OAuth client seeds.
--
-- These rows must exist before any OAuth flow runs because
-- `oauth_grants.client_id REFERENCES oauth_clients(id)` is enforced. The
-- runtime fallback in apps/web/src/lib/oauth/clients.ts still answers cache
-- lookups defense-in-depth, but the grant INSERT requires a real row.
--
-- INSERT OR IGNORE: idempotent. Safe to re-run.

-- @vegastack/pages CLI (vpg) — RFC 8628 device-code flow.
-- Public client, no secret, no redirect URIs.
INSERT OR IGNORE INTO oauth_clients (
  id,
  client_name,
  redirect_uris_json,
  software_id,
  software_version,
  token_endpoint_auth_method,
  registered_user_agent,
  registered_ip,
  created_at,
  updated_at
) VALUES (
  'oac_vpg_cli',
  'VegaStack Pages CLI (vpg)',
  '[]',
  'vpg-cli',
  NULL,
  'none',
  NULL,
  NULL,
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z'
);

-- claude.ai / Anthropic connector — RFC 7591 DCR short-circuit target.
-- The /oauth/register handler answers connector DCR with this stable id so
-- the broker doesn't time out on cold-start D1 writes.
INSERT OR IGNORE INTO oauth_clients (
  id,
  client_name,
  redirect_uris_json,
  software_id,
  software_version,
  token_endpoint_auth_method,
  registered_user_agent,
  registered_ip,
  created_at,
  updated_at
) VALUES (
  'oac_anthropic_connector',
  'Claude',
  '["https://claude.ai/api/mcp/auth_callback","https://claude.com/api/mcp/auth_callback"]',
  'anthropic-claude-ai-connector',
  NULL,
  'none',
  NULL,
  NULL,
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z'
);
