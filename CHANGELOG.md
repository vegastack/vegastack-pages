# Changelog

All notable changes to VegaStack Pages are documented here.

## 0.1.2

A tiny follow-up to v0.1.1. While debugging the claude.ai custom connector
flow over wrangler tail, we observed that the connector broker ignores both
the `WWW-Authenticate: resource_metadata` URL and the `registration_endpoint`
value advertised in the authorization-server metadata, and instead probes
RFC 9728-derived and conventional root paths. This release adds the missing
aliases so the discovery handshake completes.

### Added

- `GET /.well-known/oauth-protected-resource/mcp` — RFC 9728 §3.1 derived
  protected-resource metadata path. Returns the same JSON as the root-path
  variant.
- `POST /register` — root-level alias for RFC 7591 Dynamic Client
  Registration. Re-exports `/oauth/register`.
- `GET /authorize` — root-level alias for the authorization endpoint.
- `POST /token` — root-level alias for the token endpoint.
- `POST /revoke` — root-level alias for the revocation endpoint.
- `POST /device` — root-level alias for the device authorization endpoint.

The canonical `/oauth/*` endpoints continue to work for spec-compliant
clients (including our own `vpg` CLI device-code flow). Authorization-server
metadata still advertises the `/oauth/*` URLs.

### Changed

- `/oauth/register` and `/oauth/authorize` now set `Cache-Control: no-store`
  on every response (success, error, and consent HTML). Aligns with RFC 6749
  §5.1 and is defense-in-depth against the edge-cache-poisoning class of
  bugs documented in the wild on aggressive shared-hosting proxies in front
  of WordPress + LiteSpeed; our Cloudflare Workers deployment was not
  vulnerable, but the hardening is free.
- `vpg update` now actually updates. It queries the npm registry for the
  matching channel (`latest` for stable, `next` for prereleases), then
  shells out to the package manager that installed vpg (npm, pnpm, bun, or
  yarn) to upgrade the `@vegastack/pages` umbrella in place. New flags:
  `--check` reports the latest version without installing,
  `--channel latest|next` overrides the inferred channel. On Windows the
  binary can't replace itself while running, so `vpg update` prints the
  exact upgrade command instead. Local development builds and unknown
  install paths are refused with actionable guidance.
- Profile moved into the settings IA at `/app/settings/profile`. Legacy
  `/profile` and `/app/profile` redirect (301) so old bookmarks resolve.
  New `GET/PATCH /api/me` endpoint backs the display-name editor.
- Sidebar / theme menu refactor: theme state lives in a shared
  `apps/web/src/lib/theme.ts` and is now persisted to both `localStorage`
  and a cookie so SSR can pre-paint the right `data-theme` and avoid a
  theme flash on navigation. Folder open/closed state can now be overridden
  via a server-rendered map.

## 0.1.1

A small follow-up release. Unblocks the claude.ai custom connector add flow,
introduces browser-based device-code login for the CLI, refines a handful of
workspace + sidebar surfaces, and polishes a stray Log out chrome regression.

### Added

- **`vpg login` browser device-code flow.** With no `--token`, the CLI now
  starts an RFC 8628 device-code flow against the configured `--base-url`,
  prints (and auto-opens) the verification URL, the user picks a workspace
  on the consent page and clicks **Allow**, and the CLI polls `/oauth/token`
  until the session is granted. The chosen workspace is persisted to the
  CLI config. `--no-browser` skips the auto-launch (URL is still printed —
  useful over SSH); `VPG_NO_OPEN=1` disables auto-launch globally. Existing
  `vpg login --token <tok>` and `VPG_TOKEN` paths are unchanged and
  continue to produce `kind=cli` sessions for CI / headless agents.
- Sessions issued via the CLI device flow appear on **Settings → Sessions**
  as `kind=oauth` alongside MCP browser-OAuth sessions.
- Well-known OAuth client `oac_vpg_cli` shipped seeded by D1 migration
  `0020_oauth_well_known_vpg_cli.sql` and as a runtime fallback in
  `apps/web/src/lib/oauth/clients.ts`, so the CLI works against any
  VegaStack Pages deployment without a dynamic-registration round-trip.
- Token responses on `authorization_code` and `device_code` grants now
  include a non-standard `workspace_id` field so the CLI and OAuth-aware
  MCP clients can persist the workspace without an extra round-trip.
  Standard fields (`access_token`, `token_type`, `expires_in`,
  `refresh_token`, `scope`) are unchanged.
- `POST /api/workspaces/:id/leave` so non-admin members can leave a
  workspace themselves, with audit + admin-count guardrails on the admin
  side.
- `GET /api/csrf` — lightweight endpoint that lets the in-page fetch
  wrapper re-mint a missing `vpg_csrf` cookie and transparently retry the
  mutating request.
- VegaStack **V** brand mark in the sidebar workspace pill, the favicon
  (with `prefers-color-scheme`-aware fill), `<link rel="icon">`,
  `<meta name="color-scheme">`, and `og:image` / `twitter:image` on every
  app + docs page.

### Fixed

- claude.ai custom connector add flow now reaches the OAuth consent
  redirect instead of silently failing with "Couldn't reach the MCP
  server." `/mcp` answers `HEAD` with `200` and serves
  `MCP-Protocol-Version: 2025-06-18` on `HEAD`, `GET 405`, and the `401`
  that bootstraps OAuth — claude.ai's broker probes with HEAD before it
  follows `WWW-Authenticate`.
- `/mcp` CORS now lists `HEAD` in `Access-Control-Allow-Methods` and
  exposes `mcp-protocol-version`, `mcp-session-id`, and `www-authenticate`
  so browser-based MCP clients can read them.
- Log out row in the sidebar profile menu no longer paints the macOS
  `buttonface` full-row background. `.vpg-dropdown-item` resets
  user-agent button chrome so `<a>` and `<button>` rows render identically
  at rest and on hover.
- Comments rail collapsed/expanded state survives full page navigations.
  SSR now reads the `vpg_comments_rail` cookie and pre-paints the right
  shell-grid track + chrome via `:root[data-comments-rail]` so the rail
  doesn't flicker before hydration.
- CLI token-endpoint polling uses JSON content-type so adapter-node
  deployments (`pnpm dev`, Docker self-host) no longer reject the request
  as a cross-site form POST under Astro's built-in CSRF protection. The
  token endpoint already accepted both JSON and form-urlencoded.

### Changed

- Workspace **Members** settings refactored to a clean grid + toolbar
  layout; admin role transitions tightened with explicit last-admin
  protection on `PATCH /api/workspaces/:id/members/:memberId`.
- `release.yml` declares `emailFrom` and adds a `publish_npm` skip toggle
  so the Worker can be redeployed without forcing an npm publish.

### Docs

- README, `cli/vegastack-pages/README.md`,
  `apps/web/src/content/docs/mcp-and-cli.md`, `docs/specs/003-mcp-cli.md`,
  and `skills/vegastack-pages/references/cli.md` all describe the device
  code login alongside the existing manual-token path.

## 0.1.0

Initial public release of VegaStack Pages.

### Added

- Managed and self-hostable knowledge base app for pages, folders, rendered Markdown/HTML, attachments, public links, workspace settings, and role-based access.
- Agent-facing MCP endpoint at `/mcp` with the **MCP 2025-06-18 authorization profile**: `WWW-Authenticate` includes `resource_metadata`, plus `GET /.well-known/oauth-protected-resource` (RFC 9728), `GET /.well-known/oauth-authorization-server` (RFC 8414), `POST /oauth/register` (RFC 7591 public clients, PKCE S256 mandatory), `/oauth/authorize` + `/oauth/authorize/consent` + `/oauth/authorize/resume`, `/oauth/token` (authorization_code, refresh_token with rotation, `urn:ietf:params:oauth:grant-type:device_code`), `/oauth/revoke` (RFC 7009), and `/oauth/device` + `/oauth/device/verify` (RFC 8628). Access tokens 1h; refresh tokens 60d rotating.
- DNS-rebinding protection on `/mcp` via Host-header validation (MCP 2025-06-18 MUST). New `VPG_MCP_ALLOWED_HOSTS` env var; legacy `VPG_MCP_ALLOWED_ORIGINS` is now a no-op (bearer-only auth removes the CSRF surface).
- Unified `/app/settings/sessions` page with Mine/Workspace tabs, vendor recognition (Claude, ChatGPT, Cursor, Windsurf, Continue, Cline, Codex, vpg CLI, generic), kind chip (`oauth | manual | cli`), last-seen, and self-revoke. Sidebar moves Sessions to the Activity group above Audit log.
- Non-admin workspace members can create their own manual tokens and revoke their own sessions; admins keep full workspace-wide visibility and revocation.
- MCP tools cover sessions (`list_workspaces`, `whoami`), page creation, templates, source reads, validation, patching, attachments, comments, wait conditions, review events, publishing, workspace search, tree reads, page moves, and member invites. `reply_to_thread` is user-attributed only (agent attribution moves to `complete_review_thread`).
- `initialize.instructions` exposes a curated ≤8 KB playbook so browser-based MCP clients learn the safe edit workflow at handshake time.
- `@vegastack/pages` CLI (`vpg`) for auth, workspace selection, page CRUD, source updates, optimistic patches, rendered output, snapshots, version restore, comments, publications, search, exports, attachments, member invites, deploy helpers, and agent skill install/update. `vpg wait` accepts `--after-id <event_id>` and emits status `matched`.
- Workspace templates with structured sections, inline `<!-- guidance: ... -->` agent briefs, and typed frontmatter properties: text, longtext, number, date, datetime, boolean, single-select, and tags.
- Template surfaces across Settings, the sidebar create flow, REST API, MCP, and CLI:
  - Settings: list, create, edit, and delete templates.
  - App: create a page from a template and fill generated property fields.
  - REST API: `GET/POST /api/workspaces/:id/templates`, `GET/PATCH/DELETE /api/templates/:id`, `POST /api/templates/:id/render`, and `POST /api/templates/:id/pages`.
  - MCP: `list_templates`, `get_template`, `render_template`, and `create_page_from_template`.
  - CLI: `vpg templates list`, `vpg templates show`, `vpg templates render`, `vpg templates create`, `vpg templates update`, and `vpg create --template`.
- Fifteen seeded builtin templates across Product, Engineering, Marketing, Business, and Work: PRD, Feature brief, Discovery notes, RFC/Tech design, Postmortem, ADR, Runbook, Launch plan, Campaign brief, Executive one-pager, Meeting notes, Weekly update, 1:1 agenda, Project kickoff, and Retrospective.
- Human review loop with page and HTML comments, anchored selections, replies, resolve/unresolve, complete, review events, and agent wait conditions.
- Page version history with snapshots, source validation, optimistic edit checks, restore flow, rendered/source split, and audit-friendly event records.
- Backup to Git for workspace content, including GitHub OAuth setup, backup settings, and manual sync API.
- Public page and folder links with optional password gates and comment-capable sharing.
- Database migrations `0018_oauth_clients_and_sessions.sql` (adds `oauth_clients`, `oauth_auth_codes`, `oauth_device_codes`, plus columns on `agent_sessions` and `mcp_sessions`) and `0019_oauth_schema_cleanup.sql`.
- Local Node/SQLite development runtime, Docker install path, Cloudflare install path, CI, Changesets, npm trusted publishing workflow, and Cloudflare Worker release workflow.
- Open source project docs: README, CLI README, contributing guide, security policy, support guide, product notes, specs, install docs, public docs site content, and portable agent skill references.

### Fixed

- Persist page favorites through a user-scoped API and render initial favorites server-side.

The public CLI package has its own package changelog at
`cli/vegastack-pages/CHANGELOG.md`.

This project uses Changesets. Release entries are generated by
`pnpm run version-sync` when preparing a release.
