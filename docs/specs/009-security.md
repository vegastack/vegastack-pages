# Security And Trust Boundaries Specification

Status: Draft  
Date: 2026-05-10

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
- SameSite policy appropriate to MCP/browser auth flow.
- Session rotation after login.
- Logout destroys server-side session where applicable.

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
- MCP login/session creation.
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

Agents act through workspace-scoped MCP bearer sessions created by an authenticated workspace admin.

MCP tokens are shown once, stored hashed, scoped to one workspace, and revocable from settings.

Agent replies must record:

- User ID.
- Agent name.
- Agent model.
- Agent session ID.
- MCP or CLI client metadata where available.

MCP tools are workspace-scoped after login.
