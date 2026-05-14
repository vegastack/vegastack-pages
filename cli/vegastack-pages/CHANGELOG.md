# @vegastack/pages

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
