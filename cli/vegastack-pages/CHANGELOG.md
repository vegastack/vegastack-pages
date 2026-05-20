# @vegastack/pages

## 0.1.14-next.8

### Patch Changes

- Make the page-title row field the single source of truth and extend
  MCP session lifetimes.
  - **Title duplication fixed.** Templates ship `# {{ title }}` at the
    top of their bodies, the web "new page" dialog seeds the title as a
    leading H1 into the source, and CLI/agent users habitually paste
    the title as their first heading. The persisted source then carried
    the title twice (once on the row, once as the first H1) so every
    rendered surface showed it twice. `pages.create` and
    `pages.updateSource` now strip a leading `# {title}` (markdown/mdx)
    or `<h1>{title}</h1>` (html) that matches the page title on
    persist. Non-matching first headings (`# Introduction`, etc.) are
    left untouched. The strip is exported from `@vegastack/pages-core`
    as `stripLeadingTitleFromSource` and also applied in the unchanged-
    source guard on `PUT /api/pages/:id/source` so the no-op check stays
    consistent.
  - **`title` is now required on every create path.** `create_page`
    (MCP), `POST /api/workspaces/:id/pages` (web + CLI), and the
    template-id branch of `create_page` all surface a
    `VALIDATION_ERROR` when the title is missing or blank, instead of
    silently saving the page as "Untitled".
  - **MCP refresh token lifetime extended.** Bumped from 60 days to
    180 days, with the access token staying at 1 hour. Aligns with the
    OAuth 2.1 BCP + MCP SEP-2207 guidance on short access tokens +
    long-lived rotated refresh tokens; the longer window compensates
    for known refresh-plumbing bugs in MCP clients (Claude.ai, etc.)
    that occasionally force re-auth even when a valid refresh token
    exists.
  - **Personal MCP token default lifetime extended.** Tokens minted
    from Settings → Connections default to 365 days now (was 30) to
    match GitHub PAT / Linear API key / Notion API key conventions.
    OAuth-issued sessions are unaffected — they always specify an
    explicit lifetime.
  - **Skill docs + tool descriptions updated** in
    `packages/mcp/src/{index,instructions}.ts` and
    `skills/vegastack-pages/references/{mcp,cli}.md` to spell out the
    title contract: pass it explicitly, do not duplicate it in
    `source`.

## 0.1.14-next.7

### Patch Changes

- End-to-end edge-case hardening across MCP, CLI, and the settings UI.
  - **Attachment uploads via base64 actually decoded.** Both the MCP
    `upload_attachment` tool and the JSON `POST /api/pages/:id/attachments`
    path (used by `vpg attachments upload`) were storing the _base64
    string_ as the object body — the service layer UTF-8-encoded it as
    bytes, so every non-text attachment downloaded afterwards returned
    the base64 text instead of the original binary. Both paths now
    decode the base64 into raw bytes before storing, and surface a
    `VALIDATION_ERROR` for malformed input.
  - **`update_thread` with `complete: true` requires a body.** Previously
    passing `complete: true` without a body silently dropped the
    closing-reply intent and left the thread open. It now errors with
    `VALIDATION_ERROR`.
  - **`move_page` requires at least one of `title` or `folder_path`.**
    Calling `move_page` with neither was a silent no-op that returned
    success — confusing for agents expecting an error.
  - **Members table action icons render at 16px.** The styling rule lived
    in `docs.css`, which `SettingsLayout` does not import, so the icons
    were falling back to lucide-react's 24px default and dominating the
    row. Icons now ship with explicit `size={16}` props AND a
    defense-in-depth CSS rule moved into `settings.css`.

## 0.1.14-next.6

### Patch Changes

- `create_page` (MCP + CLI) now respects a caller-supplied `source` when
  `template_id` is also passed. Previously the template render
  unconditionally won and the caller's `source` was silently discarded —
  which broke agent workflows where Claude had already drafted prose and
  expected the template to only contribute structure/frontmatter. The new
  precedence: if `source` is a non-empty string, it wins for the body;
  the template_id is then used only to derive `source_type` and to
  validate that the supplied properties match a known schema. Omit
  `source` (or pass an empty string) to get the previous behavior — a
  fresh template render. Tool description and the agent-facing
  instructions in `@vegastack/pages-mcp` are updated to spell out the
  precedence rule explicitly.

## 0.1.14-next.5

### Patch Changes

- Fix MCP tool results to include the full payload as serialized JSON in
  the `TextContent` block, not a one-line summary. Per the MCP spec
  (2025-11-25), tools that populate `structuredContent` SHOULD also
  serialize the JSON into a `TextContent` block for backwards
  compatibility — most clients (Claude.ai, Cursor) read from
  `content[0].text` and ignore `structuredContent` unless the tool
  declares an `outputSchema`. The previous behavior collapsed every
  tool response to a string like `"VegaStack Pages:fetch: ok"`,
  leaving callers with no usable data and breaking template-driven
  workflows ("create a page from a template"). The dead
  `compactToolText` helper is removed.

## 0.1.14-next.4

### Patch Changes

- Unify the HTML Content-Security-Policy profile across the app shell and
  public publication routes (`/p/*`, `/f/*`). Previously, publications
  used a strict `script-src 'self'` while the app shell used
  `script-src 'self' 'unsafe-inline'`. The strict branch was wrong in
  practice: publications still render `AppLayout`, which emits Astro
  view-transition + theme-detect + CSRF-wrapper inline scripts, and a
  ClientRouter navigation from `/p/...` into `/app/*` carries the
  originating document's CSP into the swapped-in DOM — breaking
  dropdowns, the command palette, and settings modals on the destination
  route. Both routes now share the permissive profile and whitelist the
  Cloudflare Web Analytics beacon host (`static.cloudflareinsights.com`)
  on `script-src` + `connect-src`. The signup rate limit also moves from
  1/min to 10/min to match real-world burst behavior during onboarding.

## 0.1.14-next.3

### Patch Changes

- Surface Cloudflare `send_email` binding failures as structured log
  events instead of silently swallowing them. Until now, when SES fell
  back to Cloudflare and Cloudflare also rejected the send (e.g.,
  destination not verified, sender not on the allowlist), the only
  operator-visible signal was a generic 500 from `/api/auth/signup`. Both
  binding code paths now emit `vpg.email.cloudflare.*_failed` events with
  the upstream error message.

## 0.1.14-next.2

### Patch Changes

- Production-readiness follow-ups discovered while validating the
  v0.1.14-next.1 deploy:
  - **Signup + login form hardening.** Both `/app/signup` and `/app/login`
    forms now declare `method="post"`, an explicit `action` pointing at
    the real API endpoint, and an inline `onsubmit="event.preventDefault()"`.
    Pre-hydration the browser no longer falls through to the default GET
    submission that leaked form fields into the URL query string.
  - **`vpg signup` rate limit relaxed** to 1 request per 60s per email
    (was 4 per 30 minutes). Sane for legitimate retry-after-typo, still
    tight enough to deter abuse.
  - **Email sender pinned to `pages@vegastack.com`** in `wrangler.jsonc`
    (both `VPG_EMAIL_FROM` and the `send_email` binding allowlist) and the
    generated `worker-configuration.d.ts`. Matches the live dashboard
    override and keeps source in sync with prod.
  - **Customer-facing docs cross-links fixed** in `mcp-and-cli.md`,
    `quickstart.md`, and `pages-and-folders.md`. Bare `target.md` relative
    paths were resolving as `/docs/<current>/<target>.md` instead of
    `/docs/<target>`. Switched all 9 links to absolute `/docs/<slug>` form.
  - Operator runbook §1.4 now lists `pages@vegastack.com` as the verified
    sender + the matching `cf-bounce.vegastack.com` DKIM record.

## 0.1.14-next.1

### Patch Changes

- Fix the Cloudflare Worker deploy. The Astro 6 Cloudflare adapter
  auto-provisioned a `SESSION` KV binding by default, which the release
  verifier rejects (the architecture rebuild moved sessions to D1).
  Configure the Astro session driver to the built-in `memory` unstorage
  driver — `Astro.session` is unused, so this is purely a binding-
  suppression switch. Also remove every customer-facing mention of KV
  from the docs and install path; the only remaining references are the
  release verifier itself and the in-code comment explaining the memory
  driver choice.

## Unreleased

### Minor changes

- **Noun-first command tree (pure cutover).** `vpg` reorganized to match `gh` and `wrangler`. Hot-path verbs stay top-level (`login`, `logout`, `whoami`, `use`, `search`, `events`, `validate`, `deploy`, `doctor`, `update`, `completions`). Resource CRUD moves under noun groups: `vpg pages`, `vpg comments`, `vpg publish`, `vpg templates`, `vpg workspaces`, `vpg attachments`, `vpg skills`. Removed: `vpg create`, `vpg comment`, `vpg reply`, `vpg resolve`, `vpg unresolve`, `vpg update-anchor`, `vpg delete-thread`, `vpg complete-thread`, `vpg publish-page`, `vpg publish-folder`, `vpg revoke-publication`, `vpg update-publication`, `vpg pages prepare-edit` (now `vpg pages get --include edit_tokens`), `vpg pages patch` and `vpg pages update-source` (now `vpg pages update`), `vpg pages restore-version` (now `vpg pages restore`).
- **`--agent` on every command.** Compact JSON envelopes on stdout, structured error JSON on stderr (`{ error: { code, message, hint, details } }`), NDJSON for streaming commands. Destructive ops require `--yes` under `--agent`.
- **Exit codes 0–8.** `0` ok, `1` generic, `2` validation, `3` auth, `4` not found, `5` permission, `6` conflict, `7` network, `8` rate limited.
- **`vpg pages update` 3-mode dispatch.** Full source / find-replace / checkpoint-only, with body fields omitted-when-unset.
- **`vpg completions <shell>`.** Generated shell completions for bash, zsh, fish, and PowerShell.
- **Slug resolution everywhere.** `vpg pages get`, `update`, `move`, `restore`, `versions`, `wait`; `vpg comments *`; `vpg publish page`; and `vpg attachments upload` all accept a slug or `pg_…` id.

### Patch changes

- Bearer-authenticated requests are now exempt from CSRF, so `vpg` writes against `/api/*` work cleanly.
- `vpg use` only persists `--base-url` when explicitly passed (no silent overwrite of a stored custom origin).
- `vpg workspaces export` sanitizes the workspace id when interpolating into a default output filename.
- `vpg comments reply` / `complete` omit absent optional fields instead of sending `agent_name: null` (which strict server validators rejected).

## 0.1.13

### Patch Changes

- Consolidate the MCP tool surface around `get_page`, `search_workspace`, `update_thread`, `publication_apply`, `publication_delete`, and `list_workspace`; add consolidated page-ref and review-status APIs for faster CLI/MCP reads; improve authenticated page navigation, comments, share, sidebar, and command palette loading paths; and enable persistent Cloudflare Workers observability logs with request timing diagnostics.

## 0.1.12

### Patch Changes

- Make OAuth device verification redirect unauthenticated users with an absolute login URL so production clients do not receive an invalid relative redirect target.

## 0.1.11

### Patch Changes

- Bypass global runtime middleware for `/mcp` and let runtime-backed MCP calls manage refresh, locking, and persistence inside the MCP handler so Claude connector lifecycle probes return promptly.

## 0.1.10

### Patch Changes

- Fix Claude MCP connector tool refresh by making `/mcp` lightweight for lifecycle probes, returning an SSE-compatible GET stream, and enriching `tools/list` metadata.

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
