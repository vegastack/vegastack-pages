# @vegastack/pages-web

## 0.1.14-next.8

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.8
  - @vegastack/pages-mcp@0.1.14-next.8
  - @vegastack/pages-renderer@0.1.14-next.8
  - @vegastack/pages-services@0.1.14-next.8
  - @vegastack/pages-ui@0.1.14-next.8

## 0.1.14-next.7

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.7
  - @vegastack/pages-mcp@0.1.14-next.7
  - @vegastack/pages-renderer@0.1.14-next.7
  - @vegastack/pages-services@0.1.14-next.7
  - @vegastack/pages-ui@0.1.14-next.7

## 0.1.14-next.6

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.6
  - @vegastack/pages-mcp@0.1.14-next.6
  - @vegastack/pages-renderer@0.1.14-next.6
  - @vegastack/pages-services@0.1.14-next.6
  - @vegastack/pages-ui@0.1.14-next.6

## 0.1.14-next.5

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.5
  - @vegastack/pages-mcp@0.1.14-next.5
  - @vegastack/pages-renderer@0.1.14-next.5
  - @vegastack/pages-services@0.1.14-next.5
  - @vegastack/pages-ui@0.1.14-next.5

## 0.1.14-next.4

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.4
  - @vegastack/pages-mcp@0.1.14-next.4
  - @vegastack/pages-renderer@0.1.14-next.4
  - @vegastack/pages-services@0.1.14-next.4
  - @vegastack/pages-ui@0.1.14-next.4

## 0.1.14-next.3

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.3
  - @vegastack/pages-mcp@0.1.14-next.3
  - @vegastack/pages-renderer@0.1.14-next.3
  - @vegastack/pages-services@0.1.14-next.3
  - @vegastack/pages-ui@0.1.14-next.3

## 0.1.14-next.2

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.2
  - @vegastack/pages-mcp@0.1.14-next.2
  - @vegastack/pages-renderer@0.1.14-next.2
  - @vegastack/pages-services@0.1.14-next.2
  - @vegastack/pages-ui@0.1.14-next.2

## 0.1.14-next.1

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.14-next.1
  - @vegastack/pages-mcp@0.1.14-next.1
  - @vegastack/pages-renderer@0.1.14-next.1
  - @vegastack/pages-services@0.1.14-next.1
  - @vegastack/pages-ui@0.1.14-next.1

## 0.1.13

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.13
  - @vegastack/pages-mcp@0.1.13
  - @vegastack/pages-renderer@0.1.13
  - @vegastack/pages-ui@0.1.13

## 0.1.12

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.12
  - @vegastack/pages-mcp@0.1.12
  - @vegastack/pages-renderer@0.1.12
  - @vegastack/pages-ui@0.1.12

## 0.1.11

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.11
  - @vegastack/pages-mcp@0.1.11
  - @vegastack/pages-renderer@0.1.11
  - @vegastack/pages-ui@0.1.11

## 0.1.10

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.10
  - @vegastack/pages-mcp@0.1.10
  - @vegastack/pages-renderer@0.1.10
  - @vegastack/pages-ui@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.9
  - @vegastack/pages-mcp@0.1.9
  - @vegastack/pages-renderer@0.1.9
  - @vegastack/pages-ui@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies []:
  - @vegastack/pages-core@0.1.8
  - @vegastack/pages-mcp@0.1.8
  - @vegastack/pages-renderer@0.1.8
  - @vegastack/pages-ui@0.1.8

## 0.1.7

### Patch Changes

- Unblock Claude's OAuth token exchange after consent. The token endpoint now
  accepts the public `client_id` from an empty-secret HTTP Basic header and skips
  the D1 rate-limit write for the well-known Anthropic connector client before
  consuming the short-lived, single-use PKCE authorization code. This keeps the
  broker path inside Claude's timeout while preserving the actual grant checks.

- Updated dependencies []:
  - @vegastack/pages-core@0.1.7
  - @vegastack/pages-mcp@0.1.7
  - @vegastack/pages-renderer@0.1.7
  - @vegastack/pages-ui@0.1.7

## 0.1.6

### Patch Changes

- Disable Astro's pre-middleware `security.checkOrigin` form-origin check so
  standards-compliant OAuth token exchanges from browser MCP brokers can POST
  `application/x-www-form-urlencoded` bodies to `/oauth/token` and `/token`.
  The app-level CSRF middleware remains in force for browser mutations, while
  OAuth/MCP routes keep their deliberate bypass.

- Updated dependencies []:
  - @vegastack/pages-core@0.1.6
  - @vegastack/pages-mcp@0.1.6
  - @vegastack/pages-renderer@0.1.6
  - @vegastack/pages-ui@0.1.6

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

- Updated dependencies []:
  - @vegastack/pages-core@0.1.4
  - @vegastack/pages-mcp@0.1.4
  - @vegastack/pages-renderer@0.1.4
  - @vegastack/pages-ui@0.1.4

## 0.1.3

### Minor Changes

- Split the Sessions settings page into **My Connections** (personal, every member) and **Workspace Connections** (admin-only) so the silent permission redirect from the old combined view is gone.
  - **New routes**: `/app/settings/connections` (personal) and `/app/settings/connections/workspace` (admin). The personal page hosts the **New connection** form and lists the current user's MCP/CLI/OAuth sessions. The workspace page is read-only-plus-revoke for admins and shows an **Owner** column with the member each connection belongs to.
  - **Permission gate is now visible.** The old page rendered a `Workspace` tab to non-admins and silently redirected them back to `Mine` on click. The new sidebar only shows the **Workspace Connections** entry when the current user is an admin in the active workspace; direct URL access by a non-admin returns a `303` to `/app/settings/connections`.
  - **Legacy URL preserved.** `/app/settings/sessions` returns a `301` to `/app/settings/connections`; `/app/settings/sessions?view=workspace` returns a `301` to `/app/settings/connections/workspace`. Any inbound bookmark from the old tab shape continues to work. The mapping is extracted to a pure helper `apps/web/src/lib/settings-redirects.ts` and covered by `connections-route.test.ts`.
  - **Sidebar reshuffle**: `Activity` group now lists `My Connections` → `Workspace Connections` (admin only) → `Audit log`. The `Sessions` SectionId is removed; `connections` + `connections_workspace` replace it. `SettingsLayout` propagates `effectivePermission` from `SettingsContext` to the sidebar so the admin row is conditionally rendered without an extra round-trip.
  - **API untouched.** `apps/web/src/pages/api/mcp/sessions.ts` already enforced the right boundaries: `?view=workspace` requires admin, the default lists only the actor's sessions, `DELETE` is owner-only unless admin. The split is a pure UI refactor; existing API tests (`sessions.test.ts` + `sessions-views.test.ts`) keep coverage intact.
  - **Doc + skill find-and-replace**: README, CLI README, every reference in `docs/`, `apps/web/src/content/docs/`, and `skills/vegastack-pages/references/` now point at the new labels. The landing-page FAQ is updated too. "Settings → Sessions" → "Settings → My Connections" everywhere a user would land to create or paste a token; admin-context paragraphs additionally mention `Settings → Workspace Connections`.

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

- Updated dependencies []:
  - @vegastack/pages-core@0.1.3
  - @vegastack/pages-mcp@0.1.3
  - @vegastack/pages-renderer@0.1.3
  - @vegastack/pages-ui@0.1.3

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
  - @vegastack/pages-core@0.1.3
  - @vegastack/pages-mcp@0.1.3
  - @vegastack/pages-renderer@0.1.3
  - @vegastack/pages-ui@0.1.3

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
