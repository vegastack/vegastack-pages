# @vegastack/pages-web

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
