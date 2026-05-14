-- Seed the well-known @vegastack/pages CLI (vpg) OAuth client.
--
-- This client is referenced by the `vpg login` device-code flow (RFC 8628)
-- baked into the CLI binary. It is a public client (no secret, PKCE not
-- applicable for device-code), has no redirect URIs (device-code has no
-- browser callback), and never expires. The row exists so that
-- `oauth_grants.client_id` FK lookups succeed when the CLI initiates a
-- device authorization request against any deployment.
--
-- INSERT OR IGNORE is safe: if the row already exists from a prior seed
-- run, the migration is a no-op.

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
