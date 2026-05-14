# Security And Trust Boundaries Specification

Status: Draft  
Date: 2026-05-14

## Security Goals

- Never leak private page content through search, attachments, render cache, or public links.
- Keep public review links useful but scoped.
- Treat Markdown, MDX, HTML, SVG, Mermaid, and attachments as untrusted unless explicitly trusted.
- Keep agent actions attributable to a real user session.
- Make Cloudflare Free usable without depending on paid security add-ons.

## Trust Boundaries

Trusted:

- Server-side domain services.
- Database migrations.
- Admin-authenticated settings changes.

Conditionally trusted:

- Authenticated workspace users.
- Agent sessions tied to authenticated users.

Untrusted:

- Public link guests.
- Uploaded files.
- Markdown raw HTML.
- MDX source.
- Raw HTML pages.
- SVG files.
- Mermaid text.
- Public link passwords.
- CLI input files.

## Authentication

Required:

- Email magic link.
- First admin through setup wizard using magic link or temporary setup token/password.
- Google OAuth optional and disabled until configured.

Session requirements:

- HttpOnly cookies for browser sessions.
- Secure cookies in production.
- SameSite=Lax cookies so the OAuth consent popup at `/oauth/authorize` resolves the user session on top-level navigation.
- Session rotation after login.
- Logout destroys server-side session where applicable.

## MCP authorization (OAuth 2.1 + PKCE)

The MCP endpoint is bearer-only and supports three issuance flows that all share the `mcp_sessions` storage table.

Spec surface:

- `GET /.well-known/oauth-protected-resource` returns RFC 9728 metadata pointing at `<origin>/mcp` and the authorization server at `<origin>`.
- `GET /.well-known/oauth-authorization-server` returns RFC 8414 metadata advertising the endpoints below.
- `POST /oauth/register` is RFC 7591 dynamic client registration. Public clients only (`token_endpoint_auth_method=none`); `client_secret` is rejected. `redirect_uris` must be `https://` or RFC 8252 loopback (`http://127.0.0.1[:port]`, `http://localhost[:port]`, `http://[::1][:port]`). IP-keyed rate limit 20/h.
- `GET /oauth/authorize` renders a consent screen after the user is signed in (magic-link flow resumes via a 5-minute `vpg_oauth_pending` cookie + `/oauth/authorize/resume`). PKCE S256 is mandatory; `code_challenge_method=plain` is rejected.
- `POST /oauth/authorize/consent` mints a 60-second single-use authorization code bound to client + redirect_uri + workspace + PKCE challenge.
- `POST /oauth/token` exchanges code → 1-hour access token + 60-day rotating refresh token. Refresh-token rotation invalidates the prior refresh token on every use (one-step replay protection); attempts to reuse the rotated token return `invalid_grant`.
- `POST /oauth/revoke` follows RFC 7009 and accepts either an access token or a refresh token.
- `POST /oauth/device` + `GET/POST /oauth/device/verify` implement RFC 8628 device-authorization grant for CLI / SSH-bound clients.

Token storage:

- All bearer tokens (`oauth`, `manual`, `cli`) live in `mcp_sessions` keyed by `mcp_${sha256(rawToken)}`. The raw token is shown once at issuance and never persisted.
- Refresh tokens are stored as `mcp_${sha256(rawRefresh)}` in `mcp_sessions.refresh_token_hash` with a `UNIQUE` index. Rotation atomically replaces the hash and updates `mcp_sessions.id` to the new access-token hash.
- Workspace-admin override allows revoking any session in the workspace; non-admin members can only revoke their own sessions.

Rate limits:

- `oauth.register`: 20/h/IP.
- `oauth.token`: 60/min/IP.
- `oauth.device`: 60/h/IP.
- Device-code poll respects RFC 8628 interval/`slow_down`.

## DNS rebinding (MCP Streamable HTTP)

Per MCP 2025-11-25, the server validates the Host header on `/mcp` to prevent DNS-rebinding attacks against local self-host deployments:

- Accept the request if the Host header (or `X-Forwarded-Host`) matches the request URL host, is loopback (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`), or is enumerated in `VPG_MCP_ALLOWED_HOSTS`.
- Reject with 403 otherwise.

The legacy `VPG_MCP_ALLOWED_ORIGINS` is now a no-op; bearer auth has no CSRF surface so the origin check has been removed. CORS on `/mcp` is `Access-Control-Allow-Origin: *` without credentials.

## Authorization

Every request that reads or mutates workspace data must call `PermissionService`.

Checks required for:

- Page read.
- Source read.
- Source write.
- Comment read/write.
- Publication management.
- Attachment read/write.
- Search result visibility.
- MCP tools.
- CLI API requests.

Public publications:

- Scoped only to one page.
- Never grant sibling or folder access.
- Token stored hashed.
- Optional password stored hashed.
- Expiry enforced on every request.

## CSRF And Browser Mutations

Browser write requests must use CSRF protection unless the chosen framework/session architecture provides an equivalent guarantee.

CLI and MCP requests use bearer/session auth and are not browser form posts.

## Input Validation

Use shared schemas for:

- Page create/update.
- Comment create/reply.
- Publication create/update.
- Invite.
- Config.
- MCP tool inputs.
- CLI JSON inputs.

Reject unknown enum values.

## Rendering Security

Markdown:

- Sanitize rendered HTML with a strict allowlist.
- Strip unsafe protocols such as `javascript:`.
- Add `rel="noopener noreferrer"` for external links.
- Do not allow unsafe inline event handlers.

MDX:

- Source-first.
- Registered safe component allowlist by default.
- No arbitrary component imports from user workspace source in v1.
- Cache key includes component policy version.

HTML:

- Render arbitrary HTML in sandboxed iframe by default.
- Use restrictive sandbox attributes first, then relax only if required:
  - no top navigation
  - no same-origin unless needed
  - no forms unless explicitly supported
  - no scripts unless explicitly trusted later
- Source editing is explicit.

SVG:

- Sanitize before inline use.
- Prefer serving as attachment with safe content type and CSP.
- Strip script/event handlers and external references when sanitized.

Mermaid:

- Render client-side in a controlled component.
- Escape or sanitize rendered output.
- Handle render errors safely.

## Content Security Policy

Implement CSP early.

Baseline:

- Restrict scripts to self and known app assets.
- Restrict frames to internal sandboxed HTML preview routes.
- Restrict images to self, data where required, and permission-checked attachment routes.
- Restrict connect sources to app origin.

Adjust for Cloudflare, OAuth, and development modes explicitly.

## Attachments

V1 attachment scope:

- Images and SVG.
- Configurable max file size.
- Permission-checked serving.
- No public R2/S3 object URLs.
- Content-Disposition selected based on file type and safety.

Malware scanning is later.

## Rate Limiting

App-level rate limits:

- Magic-link request by email/IP.
- Setup attempts.
- Public link password attempts.
- Guest comment creation.
- Attachment uploads.
- MCP wait/session creation.
- CLI login attempts.
- `oauth.register` (DCR) per IP.
- `oauth.token` per IP.
- `oauth.device` per IP.

Use simple D1/SQLite-backed counters first if no platform feature is available.

## Audit Logging

Audit admin-sensitive actions:

- Setup complete.
- User invite/remove.
- Role change.
- Permission change.
- Publication create/update/revoke.
- OAuth provider config change.
- Retention setting change.
- MCP login/session creation (`mcp_session.created`, `mcp_session.revoked`).
- OAuth lifecycle (`oauth.client_registered`, `oauth.session_issued`, `oauth.session_refreshed`, `oauth.session_revoked`).
- Deploy/update metadata if app can observe it.

Audit logs should not store raw secrets or full page content.

## Secrets

Never log:

- Cloudflare API tokens.
- OAuth client secrets.
- Magic-link tokens.
- Setup tokens.
- Publication raw tokens.
- Public link passwords.
- Session cookies.

CLI:

- Store auth tokens in OS keychain where available.
- If file fallback is used, create with owner-only permissions.
- Redact tokens in `--debug` output.

## Search Security

Private search must be server-side and permission-filtered.

Do not put private workspace content into a browser-downloadable Pagefind index.

Public Pagefind is only for explicitly public/indexable exports later.

## Agent Security

Agents act through workspace-scoped MCP bearer sessions. Three issuance flows (OAuth, manual, CLI) share the same `mcp_sessions` table. Members manage their own at **Settings → My Connections**; workspace admins revoke any session across the workspace at **Settings → Connections Log**.

MCP tokens are shown once, stored hashed, scoped to one workspace, and revocable from settings.

Agent attribution is recorded only when the agent uses `complete_review_thread` (MCP) or `vpg complete-thread` (CLI). `reply_to_thread` / `vpg reply` post as the authenticated user. Recorded fields:

- User ID.
- Agent name.
- Agent model.
- Agent session ID.
- MCP or CLI client metadata where available.

MCP tools are workspace-scoped after the bearer is bound. Vendor recognition on the Sessions page is a curated `(client_name, redirect_host)` map covering Claude, ChatGPT, Cursor, Windsurf, Continue, Cline, Codex, vpg CLI, with a `generic` fallback for unknown clients.
