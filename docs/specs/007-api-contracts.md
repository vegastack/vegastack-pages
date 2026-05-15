# API Contracts Specification

Status: Draft  
Date: 2026-05-10

## Purpose

This spec defines the HTTP API surface used by the web UI, CLI, and MCP handlers. MCP tools and CLI commands should call these domain APIs or shared service functions so behavior stays consistent.

## API Principles

- All responses are JSON unless serving rendered pages, assets, or source downloads.
- All write APIs require authenticated user session, valid public edit/comment grant, or setup token.
- Every mutation checks workspace scope and effective permission.
- Every mutation returns stable machine-readable error codes.
- All write APIs accept an optional idempotency key.
- Source updates use optimistic concurrency through `base_version_id` or `etag`.
- Public links never expose raw token hashes.

## Error Shape

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You do not have write access to this page.",
    "request_id": "req_123",
    "details": {}
  }
}
```

Required codes:

- `AUTH_REQUIRED`
- `SETUP_REQUIRED`
- `SETUP_ALREADY_COMPLETE`
- `WORKSPACE_REQUIRED`
- `PERMISSION_DENIED`
- `PAGE_NOT_FOUND`
- `FOLDER_NOT_FOUND`
- `THREAD_NOT_FOUND`
- `COMMENT_NOT_FOUND`
- `SHARE_LINK_NOT_FOUND`
- `CONFLICT`
- `VALIDATION_ERROR`
- `RATE_LIMITED`
- `PAYLOAD_TOO_LARGE`
- `UNSUPPORTED_SOURCE_TYPE`
- `RENDER_ERROR`
- `INTERNAL_ERROR`

## Common Headers

Request headers:

- `Authorization: Bearer <token>` for CLI/API token flows when used.
- Cookie session for browser.
- `Idempotency-Key` for writes.
- `If-Match` or body `base_version_id` for source updates.

Response headers:

- `X-Request-Id`
- `Cache-Control` appropriate to auth and public link context.
- `ETag` for source and rendered metadata where useful.

## Setup APIs

### GET `/api/setup/status`

Returns:

```json
{
  "setup_required": true,
  "version": "0.1.0"
}
```

### POST `/api/setup/complete`

Auth:

- Operator-provided `VPG_SETUP_TOKEN`, or verified setup magic link.

Input:

```json
{
  "setup_token": "string",
  "admin_email": "admin@example.com",
  "admin_name": "Admin",
  "workspace_name": "Acme Docs"
}
```

Output:

```json
{
  "user_id": "usr_...",
  "workspace_id": "wks_...",
  "redirect_to": "/w/acme"
}
```

## Auth APIs

### POST `/api/auth/magic-link/request`

Input:

```json
{
  "email": "user@example.com",
  "redirect_to": "/"
}
```

Output:

```json
{ "ok": true }
```

Never reveal whether an email exists.

### GET `/api/auth/magic-link/verify`

Query:

- `token`

Creates session and redirects.

### GET `/api/auth/google/start`

Disabled unless Google OAuth is configured.

### GET `/api/auth/google/callback`

Completes OAuth login.

### POST `/api/auth/logout`

Destroys browser session.

## Workspace APIs

### GET `/api/workspaces`

Returns workspaces current user belongs to.

### POST `/api/workspaces`

Requires instance admin or allowed workspace creation policy.

Input:

```json
{
  "name": "Acme Docs",
  "slug": "acme"
}
```

### GET `/api/workspaces/{workspace_id}/tree`

Returns folders and pages accessible to the user.

### POST `/api/workspaces/{workspace_id}/invites`

Requires workspace admin.

Input:

```json
{
  "email": "user@example.com",
  "role": "editor"
}
```

## Folder APIs

### POST `/api/workspaces/{workspace_id}/folders`

Input:

```json
{
  "parent_folder_id": "fld_...",
  "name": "Agents",
  "position": 1000
}
```

### PATCH `/api/folders/{folder_id}`

Supports rename, move, position change.

### DELETE `/api/folders/{folder_id}`

Soft-delete unless explicitly purging in a later admin operation.

## Page APIs

### POST `/api/workspaces/{workspace_id}/pages`

Used by web UI, CLI, and MCP `create_page`.

Input:

```json
{
  "folder_id": "fld_...",
  "title": "API Review",
  "source_type": "markdown",
  "source": "---\ntitle: API Review\n---\n\n# API Review\n",
  "frontmatter": {
    "type": "spec"
  },
  "position": 1000,
  "publication_apply": {
    "permission": "comment",
    "expires_at": null,
    "password": null
  }
}
```

Output:

```json
{
  "page_id": "pg_...",
  "slug_id": "api-review-a8f31c",
  "url": "/p/api-review-a8f31c",
  "version_id": "ver_...",
  "share_url": "/p/api-review-a8f31c"
}
```

### GET `/api/pages/{page_id}`

Returns metadata and permission state.

### GET `/api/pages/by-slug/{slug_id}`

Resolves global `/p/{slug_id}` route.

### GET `/api/pages/{page_id}/source`

Requires write access except when source download is intentionally enabled later.

Output:

```json
{
  "page_id": "pg_...",
  "source_type": "markdown",
  "source": "...",
  "version_id": "ver_...",
  "etag": "..."
}
```

### PUT `/api/pages/{page_id}/source`

Requires write access.

Input:

```json
{
  "source": "string",
  "base_version_id": "ver_...",
  "checkpoint": false,
  "checkpoint_label": null
}
```

Output:

```json
{
  "page_id": "pg_...",
  "version_id": "ver_...",
  "checkpoint_created": false,
  "render_status": "queued"
}
```

Conflict output uses `CONFLICT` and includes latest version metadata.

### POST `/api/pages/{page_id}/snapshot`

Requires write access.

Input:

```json
{
  "label": "Before reviewer changes"
}
```

### POST `/api/pages/{page_id}/move`

Requires write access.

Input:

```json
{
  "folder_id": "fld_...",
  "position": 2000
}
```

### DELETE `/api/pages/{page_id}`

Soft-delete in v1.

## Render APIs

### GET `/api/pages/{page_id}/rendered`

Returns sanitized rendered HTML payload and table of contents for UI islands.

Output:

```json
{
  "page_id": "pg_...",
  "content_hash": "sha256...",
  "html": "<article>...</article>",
  "headings": [{ "depth": 2, "slug": "overview", "text": "Overview" }],
  "frontmatter": {}
}
```

The public `/p/{slug_id}` page may SSR this directly instead of calling this route.

## Comment APIs

### GET `/api/pages/{page_id}/comments`

Returns open threads by default.

Query:

- `status=open|resolved|all`

### POST `/api/pages/{page_id}/comments`

Requires comment or write access.

Input:

```json
{
  "body": "Please clarify this.",
  "anchor": {
    "selected_text": "selected phrase",
    "source_start": 120,
    "source_end": 135,
    "rendered_dom_path": "article>p:nth-of-type(2)",
    "prefix_text": "text before",
    "suffix_text": "text after",
    "content_hash": "sha256..."
  },
  "guest_name": null
}
```

Output includes thread and first reply.

### POST `/api/comment-threads/{thread_id}/replies`

Input:

```json
{
  "body": "I updated this section.",
  "agent": {
    "name": "Codex",
    "model": "gpt-5",
    "session_id": "agt_..."
  }
}
```

Agent object is only accepted from authenticated CLI/MCP agent flows.

### POST `/api/comment-threads/{thread_id}/resolve`

### POST `/api/comment-threads/{thread_id}/unresolve`

Requires comment access for own thread or write access, exact policy to be implemented in `PermissionService`.

## Share Link APIs

### POST `/api/pages/{page_id}/publications`

Requires admin/manage permission for the page.

Input:

```json
{
  "permission": "comment",
  "expires_at": null,
  "password": null,
  "indexing_enabled": false
}
```

Output:

```json
{
  "publication_id": "pub_...",
  "url": "/p/api-review-a8f31c"
}
```

The browser-facing URL is the canonical public URL. There is no hidden grant token.

### PATCH `/api/publications/{publication_id}`

Updates permission, expiry, password, indexing flag, or revokes.

### POST `/api/publications/{publication_id}/verify-password`

Creates a public grant session after password verification.

## Attachment APIs

### POST `/api/pages/{page_id}/attachments`

Requires write access.

Multipart upload.

Limits must be configurable. Initial recommendation:

- 10 MiB per file in Free-friendly Cloudflare mode.
- MIME allowlist for images and SVG in v1.

### GET `/api/attachments/{attachment_id}`

Permission-checked streaming response. Do not expose raw R2/S3 public URLs.

## Search APIs

### GET `/api/search`

Query:

- `workspace_id`
- `q`
- `limit`
- `type`: `all`, `page`, `folder`, or `comment`

Returns only accessible pages, folders, and comment threads.

Output:

```json
{
  "results": [
    {
      "type": "page",
      "id": "pg_...",
      "pageId": "pg_...",
      "folderId": null,
      "title": "API Review",
      "url": "/p/api-review-a8f31c",
      "path": "Product/API Review",
      "subtitle": "Product/API Review",
      "snippet": "...",
      "updatedAt": "2026-05-13T10:00:00.000Z",
      "icon": "file-text",
      "matchedField": "content"
    }
  ]
}
```

## Review Event APIs

### GET `/api/pages/{page_id}/events`

Used by CLI fallback if MCP streaming is unavailable.

Supports long-poll or SSE depending on runtime.

Events:

- `comment.created`
- `comment.replied`
- `comment.resolved`
- `page.updated`
- `review.condition_met`

Event payloads must match MCP event payloads where possible.

## Admin APIs

Admin APIs are web-only in v1 unless explicitly enabled later.

Required:

- Instance settings.
- Workspace settings.
- User invites/removal.
- OAuth provider config.
- Audit log list.
- Retention config.

## Rate Limits

Implement app-level rate limits for:

- Magic link requests.
- Public link password verification.
- Guest comments.
- Attachment uploads.
- CLI/MCP wait connections.

Cloudflare deployment may add platform-level rate limiting later, but app logic must not depend on paid rate limiting features.
