# @vegastack/pages-web

## 0.1.2

### Minor Changes

- Wire the Profile page into the settings IA.
  - New canonical route `/app/settings/profile` replaces the orphaned `/app/profile`. The page now appears in the settings sidebar under a new **Account** group (above **Workspace**), so it's reachable from anywhere in settings instead of being a dead-end URL.
  - Breadcrumb fix: profile pages now show `Account · Settings`, not `<Workspace Name> · Settings`. Account-scoped data does not change when you switch workspaces, so the previous kicker was misleading. `SettingsLayout.astro` gains an optional `kicker` prop that defaults to the existing workspace breadcrumb.
  - Old URLs (`/app/profile`, `/profile`) return `301` to the new location so existing bookmarks and inbound links continue to resolve.
  - **Display name is now editable** inline on the profile page. A `PATCH /api/me { display_name }` endpoint normalizes whitespace (trim + collapse internal runs), enforces a 1–80 character bound, writes a `profile.display_name_changed` audit log entry with `{ from, to }` metadata, and returns the updated user. Email remains read-only — changing it requires a verified flow (token to the new address + notification to the old) that will land in a follow-up.
  - `GET /api/me` companion endpoint returns the canonical current-user shape for client refreshes and future integrations.
  - 11 new vitest cases cover the endpoint: happy path, whitespace normalization, no-op when unchanged, empty/oversize/non-string rejection, missing field, explicit email-change rejection with helpful error message, unauthenticated 401, and malformed JSON body.
  - Profile page client script reads the `vpg_csrf` cookie and sends the matching `x-vpg-csrf-token` header so it clears the same-origin middleware check that all other browser mutations use. Save button only enables when the value would actually change, and the form soft-reloads after success so the sidebar pill and header subtitle pick up the new name.

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

- Updated dependencies []:
  - @vegastack/pages-core@0.2.0
  - @vegastack/pages-mcp@0.2.0
  - @vegastack/pages-renderer@0.2.0
  - @vegastack/pages-ui@0.2.0

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

- Updated dependencies []:
  - @vegastack/pages-core@0.1.1
  - @vegastack/pages-mcp@0.1.1
  - @vegastack/pages-renderer@0.1.1
  - @vegastack/pages-ui@0.1.1
