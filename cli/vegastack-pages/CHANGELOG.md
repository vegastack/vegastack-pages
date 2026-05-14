# @vegastack/pages

## 0.1.9

### Patch Changes

- Fix page creation when D1 search indexing runs before newly created page rows are persisted, and preserve executable permissions on packaged native `vpg` binaries.

## 0.1.8

### Patch Changes

- Default `vpg` managed-hosting commands to `https://pages.vegastack.com`, update MCP discovery to protocol version `2025-11-25`, preserve OAuth login redirect parameters, serve path-derived authorization-server metadata for MCP clients, and improve login, signup, and magic-link status handling.

## 0.1.7

### Patch Changes

- Unblock Claude's OAuth token exchange after consent. The token endpoint now
  accepts the public `client_id` from an empty-secret HTTP Basic header and skips
  the D1 rate-limit write for the well-known Anthropic connector client before
  consuming the short-lived, single-use PKCE authorization code. This keeps the
  broker path inside Claude's timeout while preserving the actual grant checks.

## 0.1.6

### Patch Changes

- Seed the well-known `oac_anthropic_connector` OAuth client in D1 via new
  migration `0021_oauth_well_known_anthropic_connector.sql`. v0.1.3 added the
  runtime fallback that lets `/register` return the pre-baked client_id
  without a D1 write, and v0.1.4 dropped `/register` latency below the
  broker's 1.5s timeout — but when the user clicked **Allow** on the consent
  screen, `/oauth/authorize/consent` tried to `INSERT INTO oauth_grants`
  with `client_id = "oac_anthropic_connector"` and D1 rejected the foreign
  key (the `oauth_grants.client_id REFERENCES oauth_clients(id)` constraint
  fails because no matching row exists). This migration adds the row.

  Same pattern as `0020_oauth_well_known_vpg_cli.sql` for the CLI device-code
  flow client. The runtime fallback in `apps/web/src/lib/oauth/clients.ts`
  stays in place as defense-in-depth for fresh deployments where the
  migration hasn't run yet.

- Disable Astro's pre-middleware `security.checkOrigin` form-origin check so
  standards-compliant OAuth token exchanges from browser MCP brokers can POST
  `application/x-www-form-urlencoded` bodies to `/oauth/token` and `/token`.
  The app-level CSRF middleware remains in force for browser mutations, while
  OAuth/MCP routes keep their deliberate bypass.

## 0.1.4

### Patch Changes

- `/oauth/*` + `/.well-known/oauth-*` now bypass the runtime persistence
  middleware. v0.1.3's Anthropic well-known short-circuit responded in
  single-digit ms inside the handler but the global middleware still ran
  `refreshRuntimeState()` + `persistRuntimeState()` around every POST,
  which adds ~1.4s of wall time per request. claude.ai's connector broker
  times out before that completes. Bypassing for OAuth endpoints — none of
  which need the global persist sweep — drops `/register` end-to-end to
  the handler's own latency.

  Also: simplified `/oauth/register` to call `auditService.record` directly
  (it's a sync in-memory push) instead of wrapping it in a
  `Promise.resolve().then(...)` / `waitUntil()` chain. v0.1.3's version
  was returning 500 from the handler's catch — root cause traced to the
  extra promise dance combined with the middleware lock, both unnecessary.

## 0.1.3

### Patch Changes

- Make `/register` fast enough for claude.ai's connector broker.

  Measured by curl: our DCR endpoint was returning in 1.8-2.4s (two D1 INSERTs
  on the hot path — the client itself + the audit log). claude.ai's broker
  aborts the request at ~1.5s, leaving the connector stuck on "Couldn't reach
  the MCP server" even though everything else was wired correctly.

  Two changes:
  - New well-known OAuth client `oac_anthropic_connector` matching the
    redirect URIs `https://claude.ai/api/mcp/auth_callback` and
    `https://claude.com/api/mcp/auth_callback`. When a `POST /register`
    payload matches that signature, we short-circuit: return the pre-baked
    client_id immediately, no D1 writes, no rate-limit write. Sub-100ms
    response. Same pattern as the existing `oac_vpg_cli` client used by the
    CLI device-code flow.
  - For generic DCR (any other client), the audit-log INSERT is now deferred
    via `ExecutionContext.waitUntil()`. The client INSERT stays synchronous
    (subsequent `/authorize` and `/token` calls have to find the client by
    id), but the audit row writes after the 201 response has been sent.
    Roughly halves response time on the slow path.

## 0.1.2

### Patch Changes

- Serve the OAuth + PRM endpoints at root-level paths so non-spec MCP clients
  can complete the connector add flow.

  Captured via wrangler tail while claude.ai's connector broker probed
  pages.vegastack.com: the broker ignores both the WWW-Authenticate
  `resource_metadata` URL and the `registration_endpoint` value from the AS
  metadata, and instead probes RFC 9728-derived + conventional root paths
  that returned 404. New aliases (re-exports of the existing `/oauth/*`
  handlers, no logic change):
  - `GET  /.well-known/oauth-protected-resource/mcp` (RFC 9728 §3.1 derived
    PRM path)
  - `POST /register` (DCR)
  - `GET  /authorize`
  - `POST /token`
  - `POST /revoke`
  - `POST /device`

  The canonical `/oauth/*` endpoints continue to work for spec-compliant
  clients (including our own `vpg` CLI device-code flow). Authorization-server
  metadata still advertises the `/oauth/*` URLs.

## 0.1.1

### Patch Changes

- Fix claude.ai custom connector discovery and dropdown Log out chrome.
  - `/mcp` now answers `HEAD` with `200` and `MCP-Protocol-Version: 2025-06-18`,
    and serves the same protocol header on `GET 405` and the `401` that
    bootstraps OAuth. claude.ai's connector broker probes with HEAD before it
    follows `WWW-Authenticate`; without it, the Add Custom Connector flow
    silently failed with "Couldn't reach the MCP server" before the OAuth
    consent redirect could open.
  - CORS on `/mcp` exposes `mcp-protocol-version`, `mcp-session-id`, and
    `www-authenticate` so browser-based MCP clients can read them, and the
    `Access-Control-Allow-Methods` list now includes `HEAD`.
  - Reset user-agent button chrome on `.vpg-dropdown-item` so the Log out row
    in the sidebar profile menu no longer paints the macOS `buttonface`
    background full-row. `<a>` and `<button>` rows now render identically at
    rest and on hover.
  - CI fix already on `main`: `release.yml` declares `emailFrom` and gains a
    `publish_npm` skip toggle for emergency deploys without an npm publish.

## 0.1.0

Initial public release of the VegaStack Pages CLI.

### Added

- Native `vpg` launcher distributed through `@vegastack/pages` with platform-specific optional packages.
- Auth and workspace commands for login, logout, identity checks, workspace listing, and workspace selection.
- Page commands for create, get, rendered output, source update, optimistic patch, validate, move, snapshots, version listing, and restore.
- Template commands for list, show, render, create, update, and `vpg create --template` page creation.
- Review commands for listing comments, creating anchored comments, replying, resolving, unresolving, completing, deleting threads, updating anchors, reading events, and waiting on review state.
- Publication commands for public page/folder links, publication updates, revocation, and default comment permission support.
- Workspace utilities for tree, search, export, attachment upload, member invites, setup doctor, deploy bootstrap, and update metadata.
- Portable VegaStack Pages skill commands for path, print, doctor, install, and update so agents can use the same MCP/CLI workflow outside this repo.

### Fixed

- Keep launcher version output aligned with the published package version.
