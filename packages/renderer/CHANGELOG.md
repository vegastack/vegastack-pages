# @vegastack/pages-renderer

## 0.1.14-next.1

## 0.1.13

## 0.1.12

## 0.1.11

## 0.1.10

## 0.1.9

## 0.1.8

## 0.1.7

## 0.1.6

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
