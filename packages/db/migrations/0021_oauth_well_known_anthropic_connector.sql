-- Seed the well-known Anthropic / claude.ai connector OAuth client.
--
-- claude.ai's connector broker POSTs RFC 7591 DCR on every Add Custom
-- Connector with `redirect_uris=["https://claude.ai/api/mcp/auth_callback"]`.
-- Our /oauth/register handler short-circuits that payload signature to
-- return a stable, pre-baked client_id (`oac_anthropic_connector`) instead
-- of doing a D1 INSERT — the broker times out around 1.5s, and our generic
-- DCR path's two D1 writes on cold start were pushing us over the cliff.
--
-- The runtime fallback in apps/web/src/lib/oauth/clients.ts answers the
-- in-memory client lookup, so subsequent `/oauth/authorize` calls validate
-- the client just fine. But when the user clicks Allow on the consent
-- screen, `/oauth/authorize/consent` writes an authorization-code row into
-- `oauth_grants`, which has `client_id REFERENCES oauth_clients(id)`. D1
-- enforces the FK and rejects the INSERT because no row exists.
--
-- This migration creates the row so the FK is satisfied. The runtime
-- fallback in clients.ts continues to short-circuit GET/cache lookups —
-- it's defense-in-depth for environments where the migration hasn't run
-- yet (the node/dev runtime + bootstrapping new deployments).
--
-- INSERT OR IGNORE: idempotent. If the row already exists, no-op.
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
