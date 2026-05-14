I have enough. Now let me verify the parity audit by listing CLI commands vs MCP tools side by side. I have all 36 MCP tools and all CLI commands. Time to write the deliverable.

---

# Implementation plan: OAuth surface, CLI/MCP parity, and unified Sessions page

This plan is grounded in a direct audit of the working tree. Citations are `path:line`. Nothing in this plan deploys, publishes, tags, or otherwise crosses the release gate in `/Users/mk/projects/vegastack-pages/CLAUDE.md:7-37`.

---

## 0. Audit findings (confirmed before planning)

### 0.1 MCP server today

- The Streamable HTTP endpoint is `apps/web/src/pages/mcp.ts`. `POST` (`mcp.ts:128-175`) calls `validateOrigin(request)` (`mcp.ts:2215-2241`) then `validateAuth(request)` (`mcp.ts:2138-2213`).
- `initialize` response (`mcp.ts:199-205`) returns `{ protocolVersion, serverInfo, capabilities: { tools: {}, resources: {}, prompts: {} } }` — **`instructions` is omitted**. Confirmed.
- The `401` path is `errorResponse` (`mcp.ts:2243-2260`). It sets `WWW-Authenticate: Bearer realm="VegaStack Pages MCP"` — **no `resource_metadata` parameter**, no `as_uri`, no `error="invalid_token"`. Confirmed.
- There are no `/.well-known/oauth-*` or `/oauth/*` routes anywhere under `apps/web/src/pages/` (verified by directory listings: `apps/web/src/pages/api/auth/` contains only `dev-login.ts`, `logout.ts`, `signup.ts`, `magic-link/`).
- Tool dispatch table is the `switch` in `callTool` (`mcp.ts:257-1240`). The spec table is `mcpToolSpecs` in `packages/mcp/src/index.ts:56-758` — 36 entries matching `mcpToolNames` (`packages/mcp/src/index.ts:1-38`).
- `listPrompts()` exposes only 3 prompts (`mcp.ts:1757-1792`): `vegastack_review_page`, `vegastack_edit_page_safely`, `vegastack_create_or_update_template`. Confirmed.
- `listResources()` already exposes the SKILL.md + 6 references plus per-page and per-workspace tree resources (`mcp.ts:1668-1698`, against `skillResources` at `mcp.ts:59-95`). Coverage is complete; no new resource URIs required.

### 0.2 Auth and bearer-token storage

- Tokens are stored in `mcp_sessions`, keyed by `mcp_${sha256(rawToken)}` (`apps/web/src/lib/runtime.ts:451-453`, `1942-1981`). The table-row id is safe to expose; the raw token is only returned in the `createMcpSession` response (`runtime.ts:1980`, surfaced through `api/mcp/sessions.ts:119-126`).
- `agent_sessions` table currently has columns `id, workspace_id, user_id, client_name, client_version, model, last_seen_at, created_at, updated_at` (`packages/db/migrations/0001_initial.sql:143-154`). **Confirmed columns missing for vendor recognition**: `kind`, `redirect_uris`, `user_agent`, `last_origin`. `last_seen_at` exists in the schema but is set once at create time and never updated by `runtime.ts:createMcpSession` — effectively unused.
- `mcp_sessions` table currently has `id, workspace_id, user_id, agent_session_id, protocol_version, expires_at, created_at, updated_at` (`migrations/0001_initial.sql:156-166`). No `refresh_token_hash`, `scope`, or OAuth-specific columns yet.
- Next migration filename: `packages/db/migrations/0018_*.sql` (last existing is `0017_remove_area_comment_anchors.sql`).
- `validateAuth` static-token branch (`mcp.ts:2149-2187`) honors `VPG_MCP_TOKEN`, refuses static tokens in production unless `VPG_ALLOW_STATIC_MCP_TOKEN=true`, and requires `VPG_MCP_WORKSPACE_ID`. Keep this exactly intact.
- API actor resolution: `apps/web/src/lib/access.ts:145-165` accepts the same bearer (`getApiRequestActor`) and looks it up via `getMcpSession` — this is what makes CLI bearer auth work against `/api/**`.

### 0.3 CORS posture today

- `validateOrigin` (`mcp.ts:2215-2241`) is enforced on every POST. Allowed origins come from `VPG_MCP_ALLOWED_ORIGINS` plus same-host plus loopback. The chosen direction (drop validation on `/mcp`, since it is Bearer-only and not cookie-authed) is sound — there is no CSRF on a bearer endpoint.

### 0.4 Sessions UI today

- `apps/web/src/pages/app/settings/mcp.astro` — single card: create form + table. Lists `mcpSessions` from `listMcpSessions({ workspaceId })` with no `userId` filter (`mcp.astro:11`) — i.e. all admin-visible sessions in the workspace.
- `SettingsLayout` (`apps/web/src/layouts/SettingsLayout.astro:7-21,32-43`) has hardcoded `currentSection` enum including `"mcp"`.
- `SettingsSidebar` (`apps/web/src/components/SettingsSidebar.astro:8-16, 62-118`) groups: Workspace (general, members), Pages (folders, templates, attachments, **mcp**), Activity (audit log).
- `folders.astro` is the template to clone — uses `settings-card-table`, `settings-table`, `settings-actions-cell`, `settings-row-action`, `closestRow`, `withTransition`, `removeRow`, `confirmAction` window helpers.
- `apps/web/src/pages/api/mcp/sessions.ts` requires **workspace admin** for GET/POST/DELETE (`api/mcp/sessions.ts:43-67`). Per-user listing is not currently filtered — `listMcpSessions` accepts an optional `userId` (`runtime.ts:1985-2010`) but the API never passes it.

### 0.5 CLI today

- Top-level commands (`cli/vegastack-pages/src/main.rs:75-301`): `Login`, `Logout`, `Whoami`, `Workspaces`, `Use`, `Create`, `Templates`, `Pages`, `Attachments`, `Members`, `Wait`, `Comments`, `Comment`, `Reply`, `Resolve`, `Unresolve`, `UpdateAnchor`, `DeleteThread`, `CompleteThread`, `PublishPage`, `PublishFolder`, `RevokePublication`, `UpdatePublication`, `Search`, `Events`, `Tree`, `Export`, `Deploy`, `Doctor`, `Skills`, `Update`.
- `Login` (`main.rs:77-80, 2324-2347`) only supports `--token` today; without a token it prints a `manual_step_required` message. There is **no loopback / browser flow** today.
- Token storage: macOS keychain via `security` (`main.rs:1172-1228`), with file fallback at `token_path()` (`main.rs:844-847`).
- Skill installer (`main.rs:1020-1106`, `854-1018`) is fully shipped — leave untouched.
- `vpg pages` subcommands (`main.rs:353-432`): `Get`, `Rendered`, `Versions`, `Snapshot`, `RestoreVersion`, `PrepareEdit`, `UpdateSource`, `Patch`, `Validate`, `Move`.
- `vpg templates` (`main.rs:310-350`): `List`, `Show`, `Render`, `Create`, `Update`.
- `vpg comments <page>` lists threads; `vpg comment <page>` creates one.
- Notable gaps surfaced in §1.6 below.

### 0.6 Skill content size budget

- SKILL.md = 60 lines (`skills/vegastack-pages/SKILL.md`).
- References: cli.md 123, comments.md 91, mcp.md 78, security.md 13, templates.md 53, workflows.md 52 (total 410 lines of references).
- For `initialize.instructions` ≤ 8 KB, a curated distillation of SKILL.md + the surface-selection rules + the review-loop summary is well within budget; do not stuff in references.

---

## 1. Parity audit — MCP tools ↔ CLI commands ↔ service

Service column references real call sites: `pageService.*` (`packages/core`), `templateService.*`, `commentService.*`, `publicationService.*`, `workspaceService.*`, `attachmentService.upload`, `reviewEventService.emit/list`, `searchIndexedResources`, plus `auditService.record` / `authService.createMagicLink` for the invite path.

| MCP tool (mcp.ts line) | CLI command (main.rs line) | Service call | Status |
|---|---|---|---|
| `create_page` (`mcp.ts:263-289`) | `vpg create` (`main.rs:1681-1718`) | `pageService.createPage` / `templates/{id}/pages` | **OK** |
| `prepare_page_edit` (`mcp.ts:290-310`) | `vpg pages prepare-edit` (`main.rs:1843-1866`) | `GET /api/pages/{id}/source?intent=edit` | **OK** |
| `patch_page` (`mcp.ts:311-334`) | `vpg pages patch` (`main.rs:1895-1923`) | `POST /api/pages/{id}/patch` → `pageService.updateSource` | **OK** |
| `update_page` (`mcp.ts:335-365`) | `vpg pages update-source` (`main.rs:1867-1894`) | `PUT /api/pages/{id}/source` | **OK** |
| `get_page` (`mcp.ts:366-378`) | `vpg pages get` (`main.rs:1789-1808`) | merge of `/api/pages/{id}` + `/source` | **OK** |
| `get_rendered_page` (`mcp.ts:379-401`) | `vpg pages rendered` (`main.rs:1809-1815`) | `GET /api/pages/{id}/rendered` | **OK** |
| `list_page_versions` (`mcp.ts:402-410`) | `vpg pages versions` (`main.rs:1816-1822`) | `GET /api/pages/{id}/versions` | **OK** |
| `create_page_snapshot` (`mcp.ts:411-442`) | `vpg pages snapshot` (`main.rs:1823-1832`) | `POST /api/pages/{id}/snapshot` | **OK** |
| `restore_page_version` (`mcp.ts:443-478`) | `vpg pages restore-version` (`main.rs:1833-1842`) | `POST /api/pages/{id}/versions` | **OK** |
| `upload_attachment` (`mcp.ts:479-510`) | `vpg attachments upload` (`main.rs:1966-1989`) | `attachmentService.upload` | **OK** |
| `validate_page_source` (`mcp.ts:511-512, 1479-1496`) | `vpg pages validate` (`main.rs:1924-1949`) | `validateEditableSource` | **OK** |
| `wait_for_review` (`mcp.ts:513-514, 1371-1477`) | `vpg wait` (`main.rs:2284-2299, 2420-2504`) | server-side long-poll vs client-side poll loop | **DESC-DRIFT — partial parity.** MCP-side wait_for_review supports `until=all_threads_resolved` and `after_event_id` cursor (`mcp.ts:1397-1452`); CLI `vpg wait` only supports the four enum values but does **not** accept `--after-id`. Plus the CLI emits status `condition_met` (`main.rs:2483`) instead of `matched`. MCP tool spec at `packages/mcp/src/index.ts:232-254` accurately describes its surface; CLI help is silent on cursors. |
| `list_comments` (`mcp.ts:515-528`) | `vpg comments <page>` (`main.rs:2008-2018`) | `commentService.listForPage` | **OK** |
| `create_comment` (`mcp.ts:529-584`) | `vpg comment` (`main.rs:2019-2054`) | `commentService.createThread` | **OK** |
| `reply_to_thread` (`mcp.ts:585-606`) | `vpg reply` (`main.rs:2055-2075`) | `commentService.reply` (user role) | **DESC-DRIFT.** MCP spec at `packages/mcp/src/index.ts:303-318` advertises `agent_name`/`agent_model`/`agent_session_id` on `reply_to_thread`, and `mcp.ts:585-606` calls `agentReplyInput(args)` which honors them. The CLI `Reply` accepts the same flags but rejects them at runtime (`main.rs:2062-2064`: "use complete-thread for agent-attributed replies"). Either the MCP description is lying or the CLI is. Fix: remove the agent fields from `reply_to_thread` MCP spec **and** server (force agents to use `complete_review_thread`), OR remove the CLI rejection. **Decision in this plan:** drop agent flags from MCP `reply_to_thread` to match CLI behavior; agent attribution flows exclusively through `complete_review_thread` / `vpg complete-thread`. |
| `resolve_thread` (`mcp.ts:607-624`) | `vpg resolve` (`main.rs:2076-2085`) | `commentService.resolve` | **OK** |
| `unresolve_thread` (`mcp.ts:625-642`) | `vpg unresolve` (`main.rs:2086-2095`) | `commentService.unresolve` | **OK** |
| `complete_review_thread` (`mcp.ts:643-679`) | `vpg complete-thread` (`main.rs:2137-2159`) | `commentService.reply` + optional `.resolve` | **OK** |
| `update_comment_anchor` (`mcp.ts:680-702`) | `vpg update-anchor` (`main.rs:2096-2129`) | `commentService.updateAnchor` | **OK** |
| `delete_thread` (`mcp.ts:703-713`) | `vpg delete-thread` (`main.rs:2130-2136`) | `commentService.deleteThread` + `removeSearchResource` | **OK** |
| `list_review_events` (`mcp.ts:714-733`) | `vpg events` (`main.rs:2261-2279`) | `reviewEventService.list` | **OK** |
| `publish_page` (`mcp.ts:734-781`) | `vpg publish-page` (`main.rs:2160-2176`) | `publicationService.upsert` (page) | **OK** |
| `publish_folder` (`mcp.ts:782-831`) | `vpg publish-folder` (`main.rs:2177-2192`) | `publicationService.upsert` (folder) | **OK** |
| `revoke_publication` (`mcp.ts:832-847`) | `vpg revoke-publication` (`main.rs:2193-2199`) | `publicationService.revoke` | **OK** |
| `update_publication` (`mcp.ts:848-892`) | `vpg update-publication` (`main.rs:2200-2240`) | `publicationService.update` | **OK** |
| `search_workspace` (`mcp.ts:893-907`) | `vpg search --type all|page|folder|comment` (`main.rs:2241-2260`) | `searchIndexedResources` | **OK** |
| `search_pages` (`mcp.ts:893-907` shares `case`) | `vpg search --type page` (`main.rs:2241-2260`) | same | **OK** — CLI overload covers both. |
| `list_workspace_tree` (`mcp.ts:908-922`) | `vpg tree` (`main.rs:2280-2283`) | `workspaceService.tree` | **OK** |
| `move_page` (`mcp.ts:923-968`) | `vpg pages move` (`main.rs:1950-1963`) | `pageService.movePage` | **OK** |
| `invite_workspace_member` (`mcp.ts:969-1051`) | `vpg members invite` (`main.rs:1990-2007`) | `workspaceService.createUser` + `addMember` + `authService.createMagicLink` + `sendMagicLinkEmail` | **DESC-DRIFT.** MCP description (`packages/mcp/src/index.ts:742-744`) says "Create or update a workspace member invite." Implementation actually creates the user if missing, adds member with role, and emails a magic link (`mcp.ts:979-1050`). CLI hits `POST /api/workspaces/{id}/invites`, which **is a route that does not exist under `apps/web/src/pages/api/workspaces/`** (only `index.ts` was listed). Verify and fix. |
| `list_templates` (`mcp.ts:1052-1070`) | `vpg templates list` (`main.rs:1720-1728`) | `templateService.listTemplates` | **OK** |
| `get_template` (`mcp.ts:1071-1093`) | `vpg templates show` (`main.rs:1729-1736`) | `templateService.getTemplateWithSource` | **OK** |
| `create_template` (`mcp.ts:1094-1126`) | `vpg templates create` (`main.rs:1756-1767`) | `templateService.createTemplate` | **OK** |
| `update_template` (`mcp.ts:1127-1168`) | `vpg templates update` (`main.rs:1768-1784`) | `templateService.updateTemplate` | **OK** |
| `render_template` (`mcp.ts:1169-1189`) | `vpg templates render` (`main.rs:1737-1755`) | `templateService.render` | **OK** |
| `create_page_from_template` (`mcp.ts:1190-1239`) | `vpg create --template` (`main.rs:1691-1705`) | same `POST /api/templates/{id}/pages` | **OK** |
| — | `vpg workspaces` (`main.rs:1680`) | `GET /api/workspaces` | **CLI-only.** Add MCP tool `list_workspaces` (description: "List workspaces the authenticated session can see. Returns id, name, slug, role for each."). Underlying call: `workspaceService.listWorkspacesForUser(actor.user.id)`. Bridges the current "you must already know workspace_id" friction for browser MCP clients. |
| — | `vpg whoami` (`main.rs:2356-2361`) | local-only summary | **CLI-only — informational.** Add MCP tool `whoami` (description: "Return the authenticated MCP session: user id, email, workspace_ids, kind = manual\|cli\|oauth, client_name, expires_at."). Underlying: actor + `listMcpSessions` filtered to current user. |
| — | `vpg export <workspace>` (`main.rs:2374-2392`) | `GET /api/workspaces/{id}/export` (zip stream) | **CLI-only — keep CLI-only.** Out of scope to expose multi-megabyte zip downloads through MCP. |
| — | `vpg doctor` (`main.rs:2300`) | `GET /api/setup/status` | **CLI-only — keep CLI-only.** Setup status is operational. |
| — | `vpg deploy` (`main.rs:2393-2407, 2506-2554`) | shells out to `pnpm deploy:cloudflare` | **CLI-only — keep CLI-only.** Local-only operator action. |
| — | `vpg skills install/update/...` (`main.rs:2301-2323`) | local filesystem only | **CLI-only — keep CLI-only.** |
| — | `vpg login / logout / use` | local config | **CLI-only — keep CLI-only.** |
| — | `vpg update check/plan/apply` (`main.rs:303-308, 2408-2412`) | local | **CLI-only — keep CLI-only.** |

### 1.1 Gaps to close in Phase 1.5

1. **Add MCP tools**: `list_workspaces`, `whoami`. (2 new entries in `mcpToolNames` and `mcpToolSpecs`; 2 new `case` arms in `callTool`.)
2. **Fix MCP `reply_to_thread`**: remove `agent_*` fields from spec and from `agentReplyInput` for the `reply_to_thread` arm. (Server keeps them on `complete_review_thread` only.)
3. **Fix `invite_workspace_member` description**: rewrite spec description in `packages/mcp/src/index.ts:742-757` to match reality — "Create or invite a workspace member by email. If the user does not exist they are created; in either case a magic link is generated and emailed when email is configured."
4. **Verify the `POST /api/workspaces/{id}/invites` endpoint actually exists** (audit could not locate the route file; `apps/web/src/pages/api/workspaces/` only listed `index.ts`). If missing, add it so `vpg members invite` works against production. (Note: this is a follow-up audit task pre-implementation, not a blind add.)
5. **Add MCP `wait_for_review` cursor flag to CLI**: rename `vpg wait` status `condition_met` → `matched`; add `--after-id <event_id>` flag matching `after_event_id` MCP arg.
6. **Tighten descriptions in `packages/mcp/src/index.ts`** to reflect actual implementation:
   - `update_page` (`index.ts:74-89`): note `allow_noop` behavior (`mcp.ts:343-354`).
   - `move_page` (`index.ts:512-524`): clarify folder must already exist (`mcp.ts:934-945`).
   - `restore_page_version` (`index.ts:183-194`): note that a checkpoint is auto-created (`mcp.ts:458-465`).
   - `upload_attachment` (`index.ts:196-215`): mention `base64_body` size budget driven by `VPG_MCP_MAX_BODY_BYTES` (`mcp.ts:2085-2110`).

---

## 2. Phase 1 — OAuth surface + spec-compliant 401 + dynamic origin

### 2.1 Files to add (one-line intent each)

- `apps/web/src/pages/.well-known/oauth-protected-resource.ts` — RFC 9728 metadata for `/mcp`, derives `resource` and `authorization_servers` from request origin.
- `apps/web/src/pages/.well-known/oauth-authorization-server.ts` — RFC 8414 AS metadata document.
- `apps/web/src/pages/oauth/register.ts` — RFC 7591 dynamic client registration (POST only).
- `apps/web/src/pages/oauth/authorize.ts` — authorization endpoint (GET, HTML response or 302; resumes magic-link login when no session cookie).
- `apps/web/src/pages/oauth/authorize/consent.ts` — POST consent submission from the authorize page.
- `apps/web/src/pages/oauth/token.ts` — token endpoint (POST; supports `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`).
- `apps/web/src/pages/oauth/revoke.ts` — RFC 7009 revocation (POST).
- `apps/web/src/pages/oauth/device.ts` — RFC 8628 device authorization endpoint (POST, returns `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval`).
- `apps/web/src/pages/oauth/device/verify.ts` — GET HTML page where the user pastes the `user_code` (or follows `verification_uri_complete`); POST approves.
- `apps/web/src/lib/oauth/issuer.ts` — `issuerForRequest(request)` and `resourceForRequest(request)` helpers; both derive from `new URL(request.url).origin`.
- `apps/web/src/lib/oauth/clients.ts` — DCR validation, storage helpers, `vendorForClient(clientName, redirectUris)`.
- `apps/web/src/lib/oauth/codes.ts` — code/refresh issuance + verification + PKCE check (S256 only).
- `apps/web/src/lib/oauth/vendor-map.ts` — curated vendor recognition table (see §6).
- `apps/web/src/pages/api/oauth/_tests/oauth.test.ts` — vitest happy-path, PKCE-failure, state mismatch, expired code, refresh, revoke-then-call.
- `packages/db/migrations/0018_oauth_clients_and_sessions.sql` — new tables + columns (see §4).

### 2.2 Files to change

- `apps/web/src/pages/mcp.ts:199-205` — emit `instructions` in `initialize` (see Phase 1.5 §5).
- `apps/web/src/pages/mcp.ts:2243-2260` — rewrite `errorResponse` to include `resource_metadata` and `as_uri` on 401.
- `apps/web/src/pages/mcp.ts:130, 2215-2241` — remove the `validateOrigin(request)` call and the function; leave a thin OPTIONS-handler block that emits `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: authorization, content-type, mcp-protocol-version`. Mark `VPG_MCP_ALLOWED_ORIGINS` as deprecated/no-op with one warning log on startup.
- `apps/web/src/pages/api/mcp/sessions.ts` — accept optional `kind` (default `"manual"`); when `kind === "manual"` keep workspace-admin requirement. The OAuth path will create sessions via `createMcpSession` directly from `oauth/token.ts` and skip the admin assertion. Add `userId` filter knob so the new Sessions page can show "Mine".
- `apps/web/src/lib/runtime.ts:1932-1981` (`createMcpSession`) — add optional fields `{ kind?: "manual" | "cli" | "oauth"; refreshTokenHash?: string | null; scope?: string | null; redirectUris?: string[] | null; userAgent?: string | null; lastOrigin?: string | null }`. Write them to the new columns (see §4). Default `kind = "manual"` so existing callers keep working.
- `apps/web/src/lib/runtime.ts:1983-2010` (`listMcpSessions`) — surface `kind`, `lastSeenAt`, `lastOrigin`, `userAgent` in the returned row; SELECT them.
- `apps/web/src/lib/runtime.ts:2012-2044` (`getMcpSession`) — on success, update `agent_sessions.last_seen_at = now()` and `last_origin = request_origin` (callers will pass them in via a new arg, or via a small `touchAgentSession(sessionId, { origin, userAgent })` helper called from `mcp.ts` after a successful auth).
- `apps/web/src/lib/access.ts:145-165` — same `touchAgentSession` after the API-side bearer lookup so cookie-less API calls also bump last-seen.

### 2.3 Route shapes

#### 2.3.1 `GET /.well-known/oauth-protected-resource`

```
{
  "resource": "<origin>/mcp",
  "authorization_servers": ["<origin>"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "<origin>/docs/mcp",
  "scopes_supported": ["mcp"],
  "resource_signing_alg_values_supported": []
}
```

Headers: `Content-Type: application/json`, `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`. Status 200.

#### 2.3.2 `GET /.well-known/oauth-authorization-server`

```
{
  "issuer": "<origin>",
  "authorization_endpoint": "<origin>/oauth/authorize",
  "token_endpoint": "<origin>/oauth/token",
  "registration_endpoint": "<origin>/oauth/register",
  "revocation_endpoint": "<origin>/oauth/revoke",
  "device_authorization_endpoint": "<origin>/oauth/device",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code"
  ],
  "token_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["mcp"]
}
```

Same headers as §2.3.1.

#### 2.3.3 `POST /oauth/register`

- Body (RFC 7591 subset): `redirect_uris` (required, array), `client_name` (required), `software_id`, `software_version`, `token_endpoint_auth_method` (must be absent or `"none"`).
- Validation: every `redirect_uri` must be `https://` OR a loopback (`http://127.0.0.1[:port]` / `http://[::1][:port]` / `http://localhost[:port]`). Reject otherwise with `invalid_redirect_uri`.
- Storage: row in new `oauth_clients` (see §4).
- Response: `{ client_id, client_id_issued_at, redirect_uris, client_name, token_endpoint_auth_method: "none", software_id, software_version }`. No `client_secret`.
- Audit: `auditService.record({ workspaceId: null, actorUserId: null, action: "oauth.client_registered", targetType: "oauth_client", targetId: client_id, metadata: { client_name, redirect_uris, ua: request.headers.get("user-agent") } })`.
- Rate-limit: `checkRateLimit({ key: "oauth.register:" + cf_connecting_ip, limit: 20, windowMs: 60*60_000 })` so DCR can't be abused.
- CORS: `Access-Control-Allow-Origin: *`, no credentials, OPTIONS preflight returns 204.

#### 2.3.4 `GET /oauth/authorize`

Query: `response_type=code` (only allowed value), `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, `resource` (optional; if present must equal `<origin>/mcp`).

Behavior:
1. Validate `client_id`, validate `redirect_uri` against the registered set, validate PKCE inputs are present and `S256`. Errors before `redirect_uri` is validated render an HTML error page; errors after redirect with `?error=invalid_request&error_description=...&state=...` per RFC 6749 §4.1.2.1.
2. If no `vpg_session` cookie (or `getRequestActor` returns anonymous), stash the full authorize request into a one-time signed cookie `vpg_oauth_pending` (5-minute TTL, HttpOnly, SameSite=Lax, Secure on https) and redirect to `/app/login?next=/oauth/authorize/resume`. The login route reuses the existing magic-link flow (`apps/web/src/pages/api/auth/magic-link/request.ts:15-69` and `verify.ts:128-153`). After verify, the existing `verify.ts:108` returns the `redirectTo` value — extend it to support `redirectTo=/oauth/authorize/resume` which re-reads the cookie and re-enters `GET /oauth/authorize`.
3. Once authenticated: render a minimal HTML consent screen showing `client_name`, recognized vendor logo from `vendor-map.ts`, requested `scope`, and a workspace picker (lists `workspaceService.listWorkspacesForUser(user.id)`). Submit goes to `POST /oauth/authorize/consent` with the same parameters + chosen `workspace_id`.
4. On consent: mint `auth_code` (32 bytes b64url), store `{ code_hash, client_id, redirect_uri, user_id, workspace_id, scope, code_challenge, expires_at = now + 60s }` in `oauth_auth_codes` (§4). Redirect to `redirect_uri?code=<code>&state=<state>`.

#### 2.3.5 `POST /oauth/token`

Body (`application/x-www-form-urlencoded`):
- `grant_type=authorization_code` + `code`, `redirect_uri`, `client_id`, `code_verifier`.
- OR `grant_type=refresh_token` + `refresh_token`, `client_id`.
- OR `grant_type=urn:ietf:params:oauth:grant-type:device_code` + `device_code`, `client_id`.

Authorization-code branch:
1. SHA-256 the incoming `code`, look up in `oauth_auth_codes`. If missing, expired (`expires_at < now`), or already consumed → return RFC 6749 §5.2 error `invalid_grant` 400.
2. Verify `client_id`, `redirect_uri` match the row exactly.
3. Verify `code_challenge == base64url(sha256(code_verifier))`. Mismatch → `invalid_grant`.
4. Mark code consumed (single-use).
5. Mint access token via `createMcpSession({ workspaceId, userId, clientName: client.client_name, kind: "oauth", scope, redirectUris: client.redirect_uris, userAgent: request.headers.get("user-agent"), lastOrigin: request.headers.get("origin") ?? null })`. Returns `rawToken` and the row id.
6. Mint refresh token (32 bytes b64url), store `refresh_token_hash = sha256(rawRefresh)` on the same `mcp_sessions` row plus `refresh_token_expires_at = now + 60d`.
7. Response: `{ access_token, token_type: "Bearer", expires_in: <seconds until access_token expires>, refresh_token, scope }`. `Cache-Control: no-store`, `Pragma: no-cache`.
8. Audit `oauth.session_issued`.

Refresh branch:
1. Look up `mcp_sessions` by `refresh_token_hash = sha256(incoming)`. If missing or `refresh_token_expires_at < now` → `invalid_grant`.
2. Rotate: invalidate the old refresh token, mint a new access token + refresh token. (Rotation is recommended by OAuth 2.1.)
3. Audit `oauth.session_refreshed`.

Device-code branch: see §2.3.7.

TTLs (final): auth code = 60s, access token = 3600s (1h), refresh token = 60d, device code = 600s, device polling interval = 5s.

#### 2.3.6 `POST /oauth/revoke`

RFC 7009. Body: `token`, optional `token_type_hint=access_token|refresh_token`, `client_id`. Hash, find session, delete. Always 200, even on miss (per spec). Audit `oauth.session_revoked`.

#### 2.3.7 `POST /oauth/device`

Body (`application/x-www-form-urlencoded`): `client_id`, `scope`. Returns:
```
{
  "device_code": "<opaque, 32 bytes b64url>",
  "user_code": "ABCD-EFGH",     // 8 alphanumeric, dashed
  "verification_uri": "<origin>/oauth/device/verify",
  "verification_uri_complete": "<origin>/oauth/device/verify?user_code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 5
}
```

Stored in new `oauth_device_codes` table (§4): `{ device_code_hash, user_code, client_id, scope, status: "pending"|"approved"|"denied", user_id, workspace_id, expires_at }`.

`GET /oauth/device/verify` renders a page that asks the user to confirm `user_code`, requires login (same magic-link resume flow as authorize), pick workspace, approve. On approve, set `status=approved`, `user_id`, `workspace_id`.

`POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`:
- `authorization_pending` if row.status == `pending`.
- `slow_down` if poll faster than `interval`.
- `expired_token` if past expiry.
- `access_denied` if row.status == `denied`.
- On `approved`: mint access + refresh as in §2.3.5, set row to consumed.

### 2.4 401 fix (`mcp.ts:2243-2260`)

New `errorResponse`:

```
if (error.status === 401) {
  const origin = new URL(error.requestUrl ?? "").origin || originFromHeader;
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
  headers = {
    "WWW-Authenticate":
      `Bearer realm="VegaStack Pages MCP", ` +
      `resource_metadata="${resourceMetadata}", ` +
      `error="invalid_token", ` +
      `error_description="Bearer token required"`,
  };
}
```

The error path needs the request URL; thread it through `errorResponse(error, request)` by changing `POST` (`mcp.ts:172-174`) to `return errorResponse(error, request)`. Replace `process.env`-driven `VPG_MCP_ALLOWED_ORIGINS` use entirely.

### 2.5 Phase 1 sequencing

1. Land the D1 migration `0018_*.sql` (§4) first; existing code paths keep working because every new column is `NULL`-permissive or has a default.
2. Land `runtime.ts` changes that read/write the new columns. Existing callers pass nothing → defaults apply.
3. Land `lib/oauth/*` helpers (pure, easy to test).
4. Land `/.well-known/oauth-*` routes (read-only — safe even before token endpoint exists, except that AS metadata advertises an endpoint that 404s; ship `register` + `authorize` + `token` in the same PR).
5. Land `/oauth/register`, `/oauth/token`, `/oauth/authorize`, `/oauth/revoke`, `/oauth/device*`.
6. Land the `mcp.ts` 401-header fix and `validateOrigin` removal in the same commit — together they make the route Bearer-only and discoverable.
7. Land `initialize.instructions` (§5) — separate commit so its diff is reviewable.

---

## 3. CORS posture changes (precise edits)

- `apps/web/src/pages/mcp.ts:130` — delete `validateOrigin(request);`.
- `apps/web/src/pages/mcp.ts:2215-2241` — delete `validateOrigin` function entirely.
- Add to `mcp.ts` (above `POST`): an `OPTIONS: APIRoute` exporting:
  ```
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: POST, OPTIONS
  Access-Control-Allow-Headers: authorization, content-type, mcp-protocol-version, mcp-session-id
  Access-Control-Max-Age: 86400
  ```
  Status 204. Never include `Access-Control-Allow-Credentials`.
- Patch the existing `POST` to emit `Access-Control-Allow-Origin: *` on **every** response (including 401 / 405 / 202). The current `Response.json` calls in `mcp.ts:160-171, 252-255, 257-259` need a small `corsHeaders()` helper.
- For each new OAuth route in `pages/oauth/*` and `pages/.well-known/*`: same `*` policy on GET/POST/OPTIONS responses. No credentials.
- `VPG_MCP_ALLOWED_ORIGINS` becomes a no-op: read once at module load, if set log a deprecation line via `console.warn` ("VPG_MCP_ALLOWED_ORIGINS is deprecated and ignored since /mcp is Bearer-only"). Document in `apps/web/README.md` (if present) and the release notes for the cycle that ships this PR.
- `validateOrigin` is **not** removed from cookie-authed routes — those routes already rely on Astro middleware and `getApiRequestActor` (`lib/access.ts:145-165`). Nothing under `/api/**` calls `validateOrigin`, so this change is scoped only to `mcp.ts`.

---

## 4. D1 migration `0018_oauth_clients_and_sessions.sql`

### 4.1 New table: `oauth_clients`

```
id                          TEXT PRIMARY KEY NOT NULL,         -- "oac_..." prefix
client_name                 TEXT NOT NULL,
redirect_uris_json          TEXT NOT NULL,                     -- JSON array
software_id                 TEXT,
software_version            TEXT,
token_endpoint_auth_method  TEXT NOT NULL DEFAULT 'none',
registered_user_agent       TEXT,
registered_ip               TEXT,
created_at                  TEXT NOT NULL,
updated_at                  TEXT NOT NULL
```

`CREATE INDEX oauth_clients_client_name_idx ON oauth_clients(client_name);`

### 4.2 New table: `oauth_auth_codes`

```
code_hash                   TEXT PRIMARY KEY NOT NULL,         -- sha256 hex of raw code
client_id                   TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
redirect_uri                TEXT NOT NULL,
user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
workspace_id                TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
scope                       TEXT,
code_challenge              TEXT NOT NULL,
code_challenge_method       TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
consumed_at                 TEXT,
expires_at                  TEXT NOT NULL,
created_at                  TEXT NOT NULL
```

`CREATE INDEX oauth_auth_codes_expires_idx ON oauth_auth_codes(expires_at);` so we can sweep expired rows cheaply (out-of-band; not required for correctness).

### 4.3 New table: `oauth_device_codes`

```
device_code_hash            TEXT PRIMARY KEY NOT NULL,
user_code                   TEXT NOT NULL UNIQUE,
client_id                   TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
scope                       TEXT,
status                      TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed')) DEFAULT 'pending',
user_id                     TEXT REFERENCES users(id) ON DELETE CASCADE,
workspace_id                TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
last_polled_at              TEXT,
expires_at                  TEXT NOT NULL,
created_at                  TEXT NOT NULL
```

### 4.4 Columns added to existing tables (in order)

`agent_sessions`:
```
ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (kind IN ('manual','cli','oauth'));
ALTER TABLE agent_sessions ADD COLUMN redirect_uris_json TEXT;
ALTER TABLE agent_sessions ADD COLUMN user_agent TEXT;
ALTER TABLE agent_sessions ADD COLUMN last_origin TEXT;
ALTER TABLE agent_sessions ADD COLUMN oauth_client_id TEXT REFERENCES oauth_clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agent_sessions_kind_idx ON agent_sessions(kind);
```

`mcp_sessions`:
```
ALTER TABLE mcp_sessions ADD COLUMN refresh_token_hash TEXT;
ALTER TABLE mcp_sessions ADD COLUMN refresh_token_expires_at TEXT;
ALTER TABLE mcp_sessions ADD COLUMN scope TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS mcp_sessions_refresh_hash_idx
  ON mcp_sessions(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;
```

### 4.5 `packages/db/src/schema.ts`

Add Drizzle / DDL mirror of the three new tables and the new columns. Update `packages/db/src/schema.test.ts` so the snapshot test (if any) covers the additions.

### 4.6 Sequencing constraint (rollout)

Migration before code. The new columns are nullable / defaulted, so the migration is forward-safe even before TS code uses them. Then code lands that *writes* `kind="manual"` to existing manual sessions implicitly. Existing rows lack `kind` only briefly during the deploy window — the `DEFAULT 'manual'` clause backfills them at ALTER time on SQLite.

---

## 5. `initialize.instructions` build-time pipeline

- Source file: `skills/vegastack-pages/distilled.md` (new) — hand-written, ≤ 8 KB of curated guidance distilled from `SKILL.md` + the surface-selection bullets + the review-loop summary + an inline list of every MCP tool name with one-line purpose lifted from `packages/mcp/src/index.ts` descriptions. Authored by maintainer, not by Claude in this PR.
- Generated TS constant: `packages/mcp/src/instructions.generated.ts` — exports `export const mcpInstructions: string`.
- Build hook: `packages/mcp/scripts/build-instructions.mjs` — reads `skills/vegastack-pages/distilled.md`, asserts `Buffer.byteLength(text, "utf8") <= 8 * 1024` (hard-fail), writes the TS constant as a single `export const mcpInstructions = ${JSON.stringify(text)};\n`. Wired into `packages/mcp` `package.json` `scripts.prebuild` so `pnpm build` regenerates it. Also re-run in `scripts.predev` so dev mode stays in sync.
- Consumed in `apps/web/src/pages/mcp.ts:199-205`:
  ```
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion,
      serverInfo: { name: "VegaStack Pages", version: "0.1.0" },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: mcpInstructions,
    });
  }
  ```
- Test: `packages/mcp/src/instructions.test.ts` — asserts byte budget, asserts presence of "patch_page", "complete_review_thread", "wait_for_review", "prepare_page_edit", "vpg login".
- Skill on-disk file is committed; CI gate is the byte-budget test plus the existing `skill_reference_mentions_every_mcp_tool_and_cli_command` test (`cli/vegastack-pages/src/main.rs:3088-3179`) to keep references aligned.

---

## 6. Phase 1.5 — MCP/CLI parity fixes + new tools

### 6.1 Files to change

- `packages/mcp/src/index.ts:1-38` — append `"list_workspaces"`, `"whoami"` to `mcpToolNames`. Append two `McpToolSpec` entries in `mcpToolSpecs`:
  ```
  {
    name: "list_workspaces",
    description: "List workspaces the authenticated session can access.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whoami",
    description:
      "Return the authenticated session: user id, email, accessible workspaces, session kind, and client name.",
    inputSchema: { type: "object", properties: {} },
  }
  ```
- `packages/mcp/src/index.ts:303-318` — drop `agent_name`/`agent_model`/`agent_session_id` from `reply_to_thread.inputSchema.properties` and update description: "Reply to a comment thread as the authenticated user. Use complete_review_thread for agent-attributed replies."
- `packages/mcp/src/index.ts:742-757` — rewrite `invite_workspace_member` description (see §1.1).
- `apps/web/src/pages/mcp.ts:257-1240` — add two new `case` arms in `callTool`:
  - `list_workspaces` → `{ workspaces: workspaceService.listWorkspacesForUser(context.actor.user.id).map(w => ({ id, name, slug, role: memberRoleOrNull(w.id, user.id) })) }`. If `context.actor.user` is null → throw `AUTH_REQUIRED`.
  - `whoami` → returns user id, email, displayName, list of accessible workspaces (id+slug+name), `authMode`, `workspaceId` (the bound one, if any).
- `apps/web/src/pages/mcp.ts:585-606` (`reply_to_thread` arm) — replace `agentReplyInput(args)` with a user-only input builder; only `complete_review_thread` retains agent metadata.
- `cli/vegastack-pages/src/main.rs:2055-2075` — `vpg reply` already rejects agent flags; no change needed.
- `cli/vegastack-pages/src/main.rs:119-127, 2284-2299, 2420-2504` — `vpg wait`:
  - Add `--after-id <event_id>` flag → passed through as `after_id` query param.
  - Rename emitted status `condition_met` → `matched` (matches MCP `waitResult` at `mcp.ts:1463-1477`).
- `skills/vegastack-pages/references/mcp.md` and `cli.md` — update to mention `list_workspaces`, `whoami`, the corrected `reply_to_thread` description, and `vpg wait --after-id`. Re-run `skill_reference_mentions_every_mcp_tool_and_cli_command` test.

### 6.2 Tests

- `packages/mcp/src/mcp.test.ts` — add cases for `list_workspaces`, `whoami`. Add a parity table fixture asserting `mcpToolNames.sort()` equals an inline list, so future drift requires an obvious code change.
- `apps/web/src/pages/_tests/mcp.test.ts` — add `tools/call` for `list_workspaces` and `whoami` with a session-bound actor.
- `cli/vegastack-pages/src/main.rs` — extend `parses_rest_backed_parity_commands` to assert `vpg wait --after-id evt_123` round-trips.

---

## 7. Phase 2 — Sessions page + sidebar reorg + vendor recognition

### 7.1 New page: `apps/web/src/pages/app/settings/sessions.astro`

Clone `folders.astro` layout. Pass `currentSection="sessions"` (we will add that enum value in `SettingsLayout.astro:10-21` and `SettingsSidebar.astro:8-16`).

Tabs (rendered as a two-button segmented control above the table, `data-tab` switching the table contents in-place with a single query-string param `?view=mine|workspace`, default `mine`):

- **Mine** — `listMcpSessions({ workspaceId, userId: currentUser.id })`.
- **Workspace** — `listMcpSessions({ workspaceId })`. Visible only when actor is workspace admin (`permissionService.resolve(...) === "admin"`).

Columns:

| Column | Source | Notes |
|---|---|---|
| Client | `session.clientName` + `vendorForClient(...)` icon | Icon left-aligned, name beside; fall back to neutral plug icon when no match. |
| Kind | `session.kind` | Chip: `manual` / `cli` / `oauth`. |
| Created | `formatDate(session.createdAt)` | |
| Last seen | `formatDate(session.lastSeenAt)` | Empty dash when `null` (manual sessions issued before this feature). |
| Last origin | `session.lastOrigin` or `session.userAgent` truncated | Hover tooltip shows the full UA. |
| Expires | `formatDate(session.expiresAt)` | |
| Actions | revoke (red X) | Same modal as `mcp.astro:225-254`. |

"New session" card supports two flows side by side:

1. **Manual token** (existing behavior): `client_name` input, "Create session" button, reveals the token + JSON config exactly like `mcp.astro:30-65, 154-256`.
2. **Connect a browser client** (new): paste-instructions block showing the MCP URL `https://<origin>/mcp` and a note "Your MCP client (Claude, ChatGPT, Cursor, …) will start its own OAuth flow when it reaches this URL — no setup needed here." Includes a "Copy URL" button. This is informational; the actual OAuth dance happens in §2.

DELETE call goes to `/api/mcp/sessions` (unchanged shape; only the `view` filter is new).

### 7.2 Sidebar reorg (`apps/web/src/components/SettingsSidebar.astro:8-16, 62-118`)

- Add `"sessions"` to the `SectionId` union.
- Add `connection` icon key (Lucide `plug-2` or reuse `plug`).
- Remove the existing `{ id: "mcp", ... }` entry from the **Pages** group at line 104.
- Append a new entry into the **Activity** group, *above* `Audit log`:
  ```
  { id: "sessions", label: "Sessions", href: "/app/settings/sessions", icon: "plug" }
  ```
- Make the same edit in `SettingsLayout.astro:27-43`: replace `mcp` with `sessions`, drop the `Audit` label collapse, add Sessions before Audit.
- Delete `apps/web/src/pages/app/settings/mcp.astro` (the route disappears, no redirect — confirmed in the brief).

### 7.3 Vendor recognition map (`apps/web/src/lib/oauth/vendor-map.ts`)

Shape:

```
type Vendor = {
  id: string;
  label: string;
  iconSvg: string; // inline SVG; small budget, no remote fetch
  matchers: Array<{ clientName?: RegExp; redirectHost?: RegExp }>;
};

export const VENDORS: Vendor[] = [
  { id: "claude",     label: "Claude",          iconSvg: "...",
    matchers: [{ clientName: /^claude/i }, { redirectHost: /(^|\.)claude\.ai$/i }] },
  { id: "chatgpt",    label: "ChatGPT",         iconSvg: "...",
    matchers: [{ clientName: /chatgpt|openai/i }, { redirectHost: /(^|\.)chatgpt\.com$/i }] },
  { id: "cursor",     label: "Cursor",          iconSvg: "...",
    matchers: [{ clientName: /^cursor/i }, { redirectHost: /(^|\.)cursor\.(com|sh)$/i }] },
  { id: "windsurf",   label: "Windsurf",        iconSvg: "...",
    matchers: [{ clientName: /windsurf/i }, { redirectHost: /(^|\.)codeium\.com$/i }] },
  { id: "continue",   label: "Continue",        iconSvg: "...",
    matchers: [{ clientName: /^continue/i }] },
  { id: "cline",      label: "Cline",           iconSvg: "...",
    matchers: [{ clientName: /^cline/i }] },
  { id: "vpg-cli",    label: "VegaStack CLI",   iconSvg: "...",
    matchers: [{ clientName: /^vpg|vegastack-pages/i }] },
  { id: "generic",    label: "MCP client",      iconSvg: "...",
    matchers: [] },
];

export function vendorForClient(input: { clientName: string; redirectUris?: string[] | null }): Vendor;
```

The function tries every matcher; first hit wins; `generic` is the fallback. The vendor id is what the Sessions page reads for icon lookup; unknown vendor → render literal `clientName`.

---

## 8. Phase 1.5/2 — CLI `vpg login` rework

### 8.1 Behavior matrix

| Invocation | Path |
|---|---|
| `vpg login` (interactive TTY, has DISPLAY or macOS/Windows) | Loopback OAuth |
| `vpg login --token <tok>` | Headless: store token (existing `main.rs:2324-2347` behavior) |
| `vpg login --no-browser` or detected SSH (`SSH_CONNECTION`/`SSH_TTY` set) or no DISPLAY on Linux | Device-code |
| `VPG_TOKEN=… vpg <anything>` | Existing env path; do not touch |

### 8.2 Loopback OAuth flow

1. Generate `code_verifier` (64 bytes b64url-no-pad). Compute `code_challenge = base64url(sha256(code_verifier))`.
2. Bind a loopback HTTP server on an ephemeral port in the range **49152..65535** using OS-assigned (`TcpListener::bind("127.0.0.1:0")`). Path `/callback`. Callback timeout **120s**.
3. Discover endpoints from `<base-url>/.well-known/oauth-authorization-server`. If 404, fall back to `<base-url>/oauth/authorize` and `<base-url>/oauth/token` with a warning.
4. If `~/.config/vegastack-pages/oauth-client.json` does not exist for this `base_url`, POST `/oauth/register` with `client_name = "vpg CLI"`, `redirect_uris = ["http://127.0.0.1:<port>/callback"]`. Cache the returned `client_id` (re-registration must happen per-port; in practice we register fresh each login, since DCR is cheap and we cannot pre-reserve the port).
5. Open the browser to `<authorization_endpoint>?response_type=code&client_id=...&redirect_uri=...&scope=mcp&state=<random>&code_challenge=...&code_challenge_method=S256&resource=<base-url>/mcp` via `open` crate (already in CLI dep tree — verify) or `xdg-open` / `open` / `cmd /c start` shell-out.
6. Wait on the loopback server for `GET /callback?code=...&state=...`. Verify `state`. Exchange code at the token endpoint with `code_verifier`. Receive `{access_token, refresh_token, expires_in}`.
7. Store `access_token` via existing `write_stored_token` (`main.rs:1287-1295`) — same place CLI tokens already live, so `getMcpSession` finds it. Store `refresh_token` and `refresh_expires_at` alongside in a new private file `~/.config/vegastack-pages/refresh` (mode 0o600) **or** the keychain under service `vegastack-pages-refresh`. The CLI does **not** auto-refresh today (the access token lasts an hour); add a `refresh_if_needed()` call inside `Api::new` (`main.rs:691-710`) that, if a refresh token is present and the stored access token is within 60s of expiry, swaps it. Out-of-scope for v1 if it bloats; document as v1.1 in the risk register.
8. Reply to the loopback request with a small HTML "VegaStack Pages: you can close this tab." page.
9. Audit `oauth.session_issued` fires server-side via §2.3.5; no CLI-side audit emission.

### 8.3 Device-code flow

1. POST `/oauth/device` with `client_id` (re-register if necessary), `scope=mcp`.
2. Print to stderr:
   ```
   To finish signing in, open https://pages.vegastack.com/oauth/device/verify
   and enter the code: ABCD-EFGH
   ```
3. Poll `/oauth/token` every `interval` seconds (default 5s, honor `slow_down` by `interval += 5`).
4. Stop on `access_denied`, `expired_token`, or success. Same storage as §8.2.

### 8.4 CLI changes (`cli/vegastack-pages/src/main.rs`)

- Add `--no-browser` global flag on `Login` (`main.rs:77-80`).
- Add module `src/oauth/mod.rs` (new file) containing `LoginFlow` enum + `run_login_loopback`, `run_login_device` functions. Reuse `Api`/`Client` for HTTP.
- Add `Cargo.toml` deps: `tiny_http = "0.12"` (single-file HTTP server, no async runtime) and `webbrowser = "1.0"` for the cross-platform open. Verify these are MIT/Apache-2 and small.
- Rewrite the `Some(Command::Login { token })` arm at `main.rs:2324-2347` to branch on token presence as in §8.1.

---

## 9. Audit log events

Confirmed `auditService.record` is used as `{ workspaceId, actorUserId, action, targetType, targetId, metadata }` (`mcp.ts:139-150, 466-476, 1026-1042` etc.). The `auditService.record` call shape is stable.

Add these new `action` values:

- `oauth.client_registered` — at end of `POST /oauth/register`. `workspaceId: null`, `actorUserId: null`. Metadata: `{ client_name, redirect_uris, software_id, software_version, ua, ip }`.
- `oauth.session_issued` — in `/oauth/token` after a successful authorization_code or device_code grant. `workspaceId: <chosen>`, `actorUserId: <user.id>`. Metadata: `{ client_id, client_name, scope, redirect_uri, ua, origin, flow: "code" | "device" }`.
- `oauth.session_refreshed` — refresh_token grant. Metadata: `{ client_id, scope }`.
- `oauth.session_revoked` — `/oauth/revoke` or settings-page DELETE for an OAuth-kind session. Metadata: `{ client_id, reason: "user" | "expired" }`.
- `mcp.tool_called` — **new event** in `apps/web/src/pages/mcp.ts` `callTool` wrapper. Sample at most once per (actor, tool) per 60s to avoid log spam; full payload deliberately not logged (tools handle their own audit emits already, e.g. `restore_page_version` at `mcp.ts:466-476`). Phase 3, drop if bloat.

The existing audit emissions stay as-is.

---

## 10. Tests

### 10.1 Phase 1

- `apps/web/src/pages/_tests/well-known.test.ts` (new) — GET both `.well-known` URLs, assert `issuer` and `resource` are derived from the request `Host` header (parameterize over `https://pages.vegastack.com` and `https://example.test` to confirm self-host derivation).
- `apps/web/src/pages/_tests/mcp.test.ts` (existing) — extend with:
  - 401 response now includes `resource_metadata=` in `WWW-Authenticate`.
  - `validateOrigin` removed: a POST with a cross-origin `Origin` header succeeds when bearer is valid (no more `PERMISSION_DENIED`).
  - OPTIONS preflight returns 204 with `Access-Control-Allow-Origin: *`.
- `apps/web/src/pages/api/oauth/_tests/oauth.test.ts` (new) — happy-path code → token, PKCE-failure rejects with `invalid_grant`, expired code rejects, refresh rotates, revoke + later `getMcpSession` returns null, state mismatch on `/oauth/authorize` returns `invalid_request`, DCR with non-loopback http URL is rejected, DCR with `client_secret` field set is rejected, OPTIONS preflight ok.

### 10.2 Phase 1.5

- `packages/mcp/src/mcp.test.ts` — parity table assertion + `list_workspaces` + `whoami`.
- `apps/web/src/pages/_tests/mcp.test.ts` — `list_workspaces` returns only workspaces the actor can read; `whoami` returns kind, email, accessible workspaces.
- `apps/web/src/pages/_tests/mcp.test.ts` — `reply_to_thread` rejects `agent_*` args (so the spec stays honest).
- `cli/vegastack-pages/src/main.rs` (`#[cfg(test)] mod tests`) — `vpg wait --after-id evt_123` parses; emitted status string is `matched`.
- `packages/mcp/src/instructions.test.ts` (new) — byte budget + presence of "patch_page", "complete_review_thread", "wait_for_review", "prepare_page_edit", "vpg login".

### 10.3 Phase 2

- `apps/web/src/pages/_tests/sessions-page.test.ts` (new) — render the page server-side (or test the data loader), assert "Mine" tab filters by `userId`, "Workspace" tab returns the admin-visible set, non-admin actor cannot see the Workspace tab.
- `apps/web/src/pages/api/mcp/_tests/sessions.test.ts` (existing) — extend to assert the new `view=mine` filter is honored.
- `apps/web/src/lib/oauth/vendor-map.test.ts` (new) — every shipping entry matches its expected `(client_name, redirect_host)` and falls through to `generic` on unknown.

### 10.4 CLI login (when CLI changes land)

- `cli/vegastack-pages/src/oauth/tests.rs` (new) — mock HTTP server, run loopback flow end-to-end on a fixed port (use `127.0.0.1:0` then read the bound port); assert `state` validation; assert PKCE verifier matches what was sent.

---

## 11. Rollout sequencing (commit-by-commit, no half-broken states)

1. **Commit A — D1 migration only.** `0018_oauth_clients_and_sessions.sql` + `packages/db/src/schema.ts` mirror + tests. No callers touched.
2. **Commit B — runtime + access plumbing.** `runtime.ts` accepts the new fields with defaults; `access.ts` calls `touchAgentSession`. Existing callers unchanged. Tests for `createMcpSession` defaults and last-seen update.
3. **Commit C — OAuth library helpers.** `lib/oauth/*` (pure functions: PKCE verify, token mint, code hash). 100% covered by unit tests; nothing wired in routes yet.
4. **Commit D — OAuth routes + `.well-known`.** Adds the eight routes from §2.1. Existing `/mcp` 401 unchanged.
5. **Commit E — `/mcp` 401 fix + CORS posture + `validateOrigin` removal.** Smallest possible diff that flips the route into discoverable mode. After this commit lands locally, `https://pages.vegastack.com/mcp` advertises its AS metadata.
6. **Commit F — `initialize.instructions`.** Build script + generated TS + wiring + test.
7. **Commit G — MCP/CLI parity fixes.** Phase 1.5: new tools, description rewrites, CLI `vpg wait --after-id`, skill reference updates.
8. **Commit H — Sessions page + sidebar + vendor map.** Delete `mcp.astro`, add `sessions.astro`, update layout enum, update sidebar.
9. **Commit I — CLI `vpg login` rework.** Loopback + device-code, behind release-cycle copy in `CHANGELOG`.

Each commit independently passes `pnpm typecheck && pnpm test && pnpm build` and the CLI `cargo test` where touched. Nothing in any commit invokes `wrangler deploy`, `pnpm publish`, or `gh release` — release stays out of scope per `CLAUDE.md:7-37`.

---

## 12. Risk register (top 5)

1. **DCR spam.** Anyone can call `POST /oauth/register`. Mitigation: IP-keyed rate limit (`checkRateLimit({ limit: 20, windowMs: 3600_000 })`); periodic sweep of `oauth_clients` with no associated session after 7 days (out-of-band Phase 3).
2. **`oauth_auth_codes` table growth.** 60-second TTL means rows accumulate briefly. Mitigation: index on `expires_at`; sweep job out-of-band (Phase 3) or on-demand at insert time delete rows where `expires_at < now()-300`.
3. **Astro session cookie + OAuth popup interaction.** Claude.ai opens `/oauth/authorize` in a popup; if cookie `SameSite=Lax` doesn't ride along on a cross-site top-level navigation, the user appears unauthenticated and we redirect to magic-link login. Mitigation: existing `vpg_session` cookie at `verify.ts:101-107` is already `SameSite: "lax"`, which does ride on top-level navigations — but a popup opened from `claude.ai` could be treated as a top-level nav OR an iframe nav depending on browser policy. Test in Chrome, Safari, Firefox before declaring victory; fall back to embedding a "Sign in" link the user clicks once.
4. **Self-hosted base URL detection across reverse proxies.** `request.url` inside Astro on Cloudflare uses the public hostname; behind nginx/Caddy in self-host it may use the internal one. Mitigation: prefer `X-Forwarded-Host` + `X-Forwarded-Proto` when present, otherwise fall back to `request.url`. Centralize this in `lib/oauth/issuer.ts:issuerForRequest`.
5. **`instructions` payload size in clients.** MCP clients are not all tolerant of large `instructions` strings; some truncate at ~4 KB. Mitigation: ≤8 KB is a server-side ceiling but the distilled content should aim for ~4 KB to maximize compatibility; the byte-budget test should set the warning threshold lower than the hard fail.

---

## 13. Out of scope

- All release-gate actions: `git push`, `git tag`, `wrangler deploy`, `pnpm publish`, `gh workflow run`, `gh release create`. Per `CLAUDE.md:7-37`.
- Phase 3 SSO bridge / external IdP integration.
- Personal-scope skills.
- Workspace-defined-prompts CRUD UI (the earlier "Phase 1.5 skills" sketch the brief explicitly redirected away from).
- `vpg export` over MCP (zip stream, not justified through JSON-RPC content).
- `vpg deploy`, `vpg doctor`, `vpg update` over MCP — local-operator tools.
- Workspace-wide audit log UI changes (only the new `oauth.*` event types ship; the existing `audit.astro` already iterates whatever is in the table).
- Token rotation on every refresh's *access token* (we rotate refresh tokens for OAuth 2.1 compliance; we do not rotate access tokens mid-life).
- Background sweep job for expired `oauth_auth_codes` / `oauth_device_codes` (Phase 3 polish).

---

## What I'm uncertain about

1. **`POST /api/workspaces/{id}/invites` existence.** The CLI calls this (`main.rs:1997-2005`) and `vpg members invite` is supposedly working in production, but my directory listing of `apps/web/src/pages/api/workspaces/` showed only `index.ts`. Either the route lives somewhere I missed (an Astro dynamic route I didn't render), or the CLI command is dead. Resolution: `Grep` for `invites` across `apps/web/src/pages/api/` before implementation, and either add the route or strike the parity row.
2. **`webbrowser` and `tiny_http` crate licenses + sizes** for the CLI. They are likely fine but worth confirming before adding to `Cargo.toml` — both must be MIT/Apache-2 to match the rest of the project license posture in `cli/vegastack-pages/LICENSE`. Resolution: read each crate's `Cargo.toml` / docs.rs page.
3. **Whether `vpg_session` cookie rides cross-site to `pages.vegastack.com/oauth/authorize`** opened in a Claude.ai popup. Browser policy varies. Resolution: empirically test against the dev tunnel in all three browsers once the routes exist locally.
4. **Whether Astro's request URL is reliably the public origin under all self-host reverse proxy configs.** Specifically whether `request.url` for an Astro Worker behind nginx in front of a Node adapter still reflects the public scheme/host. Resolution: write a tiny `/api/echo-origin` test route and try it in `install/docker`.
5. **Whether the current managed Cloudflare deploy enforces `requiresManagedDurableStorage()`** in a way that would refuse to boot if a self-hoster runs without R2 (`runtime.ts:466-501`). The new OAuth tables are D1-only, but the `assertRuntimeStorageBindings` check applies broadly. Resolution: read the full function and confirm new tables don't need R2 to function.
6. **MCP spec exact `WWW-Authenticate` shape.** RFC 9728 and the MCP 2025-06-18 authorization spec both accept the header form I drafted in §2.4, but Claude.ai's current implementation may be stricter than spec. Resolution: verify against the published `modelcontextprotocol` reference server header format once routes exist.

### Critical files for implementation

- /Users/mk/projects/vegastack-pages/apps/web/src/pages/mcp.ts
- /Users/mk/projects/vegastack-pages/apps/web/src/lib/runtime.ts
- /Users/mk/projects/vegastack-pages/packages/mcp/src/index.ts
- /Users/mk/projects/vegastack-pages/cli/vegastack-pages/src/main.rs
- /Users/mk/projects/vegastack-pages/packages/db/migrations/0001_initial.sql
