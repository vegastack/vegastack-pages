# MCP And CLI Specification

Status: Draft  
Date: 2026-05-14

## Summary

VegaStack Pages exposes two agent surfaces:

- Remote MCP mounted at `/mcp`.
- Rust CLI distributed through npm package `@vegastack/pages`.

Both surfaces must use the same vocabulary, permission checks, and error model.

## CLI Distribution

Package:

```text
@vegastack/pages
```

Command aliases:

```text
vpg
vegastack-pages
```

Both aliases call the same Rust binary.

Suggested npm package shape:

```json
{
  "name": "@vegastack/pages",
  "bin": {
    "vpg": "./bin/vpg.js",
    "vegastack-pages": "./bin/vpg.js"
  }
}
```

The JS launcher locates the platform-specific prebuilt Rust binary. Users should not need Rust installed.

## CLI Principles

- Secure by default.
- Non-interactive mode for agents and CI.
- Interactive mode for humans.
- Machine-readable JSON output through `--json`.
- Stable exit codes.
- No secrets printed by default.
- Tokens stored in OS keychain where available, with file fallback clearly protected.
- Workspace-scoped after login.
- Same permission checks as web and MCP.

## CLI Commands

Core:

```sh
vpg login
vpg logout
vpg whoami
vpg workspaces
vpg use <workspace>
vpg create
vpg update
vpg upload
vpg get
vpg open
vpg wait
vpg comments
vpg reply
vpg resolve
vpg publish-page
vpg publish-folder
vpg update-publication
vpg revoke-publication
vpg search
vpg export
vpg deploy
vpg doctor
vpg update
vpg version
```

Aliases:

- `vegastack-pages <command>` works for every `vpg <command>`.

Examples:

```sh
vpg create --title "API Review" --file api-review.md --json
vpg create --title "Plan" --type markdown --stdin
vpg wait api-review-a8f31c --until first_response --json
vpg comments api-review-a8f31c --json
vpg reply <thread-id> --body "I updated this section." --json
vpg deploy --config vegastack-pages.yaml
vpg update --check --json
```

## Wait Semantics

`wait` means the CLI or MCP call stays active until review input arrives or a condition is met.

Supported wait conditions:

- `first_response`: first human comment/reply arrives.
- `new_comment`: any new comment thread arrives.
- `all_threads_resolved`: every open thread is resolved.
- `timeout`: end after timeout.

Status field on the matched return is `matched`. On timeout it is `timeout`. Pass `--after-id <event_id>` (CLI) or `after_event_id` (MCP) to resume from a known cursor.

Example:

```sh
vpg wait page-title-abc123 --until first_response --timeout 30m --after-id evt_42 --json
```

Return payload includes:

- Page ID.
- Event type.
- Thread ID.
- Selected text.
- Prefix/suffix context.
- Comment body.
- Reviewer identity or guest name.
- URL.

## Remote MCP

Endpoint:

```text
/mcp
```

Managed endpoint:

```text
https://pages.vegastack.com/mcp
```

Transport:

- Streamable HTTP (MCP 2025-06-18) over POST. OPTIONS preflight returns 204 with `Access-Control-Allow-Origin: *`.
- Server-Sent Events only if compatibility requires it later.
- Host-header validation rejects mismatched hosts (DNS-rebinding guard). Loopback hosts and entries in `VPG_MCP_ALLOWED_HOSTS` are permitted regardless.

Auth:

- Bearer-only on `Authorization: Bearer <token>`. No cookie auth, no CSRF surface, so `Access-Control-Allow-Origin: *` with no credentials.
- 401 emits `WWW-Authenticate: Bearer realm="VegaStack Pages MCP", resource_metadata="<origin>/.well-known/oauth-protected-resource", error="invalid_token"` so MCP 2025-06-18 clients self-onboard.
- Three flows, one storage shape:
  - **OAuth 2.1 + PKCE** for browser MCP clients via `/.well-known/oauth-protected-resource` (RFC 9728), `/.well-known/oauth-authorization-server` (RFC 8414), `/oauth/register` (RFC 7591 public-client DCR, PKCE S256 mandatory), `/oauth/authorize` + `/oauth/authorize/consent`, `/oauth/token` (1h access, 60d refresh, refresh rotation), `/oauth/revoke` (RFC 7009), `/oauth/device` + `/oauth/device/verify` (RFC 8628).
  - **`vpg` CLI device-code (default `vpg login`)** uses the well-known client `oac_vpg_cli` baked into the server (no dynamic registration round-trip) and POSTs to `/oauth/device`, prints/opens the verification URL, polls `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` until the user picks a workspace and clicks Allow. Token response includes a non-standard `workspace_id` field so the CLI persists the workspace without an extra call. Sessions appear with `kind=oauth`.
  - **Manual bearer** issued from **Settings → Sessions** by a workspace member (creator owns it; admin can revoke any). Used by `vpg login --token`, `VPG_TOKEN`, and `--token` per-call. Sessions appear with `kind=cli` when stored via the CLI, `kind=manual` when used directly.
- Static bearer-token fallback (`VPG_MCP_TOKEN`) is local/debug only and stays disabled in production unless `VPG_ALLOW_STATIC_MCP_TOKEN=true`.
- Every issued token lives in `mcp_sessions` with `agent_sessions.kind ∈ {manual, cli, oauth}`. `Settings → Sessions` reads from the same table.

## MCP Tools

Tool names mirror CLI verbs in snake_case:

Session:

- `list_workspaces`
- `whoami`

Page lifecycle:

- `create_page`, `create_page_from_template`
- `get_page`, `get_rendered_page`, `list_page_versions`
- `prepare_page_edit`, `patch_page`, `update_page`, `validate_page_source`
- `move_page`, `create_page_snapshot`, `restore_page_version`
- `upload_attachment`

Review:

- `wait_for_review` (accepts `after_event_id` cursor; emits `status: matched | timeout`)
- `list_comments`, `create_comment`
- `reply_to_thread` (user attribution only)
- `complete_review_thread` (agent-attributed; accepts `agent_name`, `agent_model`, `agent_session_id`; optional `resolve` in one call)
- `resolve_thread`, `unresolve_thread`, `update_comment_anchor`, `delete_thread`
- `list_review_events`

Publishing:

- `publish_page`, `publish_folder`, `update_publication`, `revoke_publication`

Search and navigation:

- `search_workspace`, `search_pages` (page-only compatibility alias)
- `list_workspace_tree`

Templates:

- `list_templates`, `get_template`, `create_template`, `update_template`, `render_template`

Members:

- `invite_workspace_member` (creates user if missing, adds member, emails magic link when email is configured)

## initialize.instructions

The `initialize` response includes an `instructions` string (≤8 KB) distilled from `skills/vegastack-pages/SKILL.md`. Clients that honor the field inject it into the model's system prompt. The same content is available as MCP resources under `vpg://skills/vegastack-pages/...`.

## MCP Resources

Resources:

- `workspace://{workspace_id}/tree`
- `page://{page_id}/source`
- `page://{page_id}/rendered`
- `page://{page_id}/comments`
- `page://{page_id}/metadata`

Resource reads must enforce permissions.

## MCP Error Model

Errors must be structured:

- `AUTH_REQUIRED`
- `WORKSPACE_REQUIRED`
- `PERMISSION_DENIED`
- `PAGE_NOT_FOUND`
- `THREAD_NOT_FOUND`
- `CONFLICT`
- `VALIDATION_ERROR`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

Include actionable messages for humans and stable codes for agents.

## Page Creation Inputs

CLI and MCP page creation must accept:

- Raw content from stdin.
- Local file path.
- Title.
- Folder/path.
- Source type: Markdown, MDX, HTML.
- Frontmatter/metadata JSON.
- Initial share settings.
- Wait condition.
- Template id or slug plus typed properties when creating from a template.

## Security Requirements

- Workspace-scoped tools.
- No instance-admin MCP tools in v1.
- All write tools require CSRF/session-safe auth where relevant.
- Public publication tokens are not exposed through MCP unless creating a link.
- Agent replies include user-bound session metadata.
- Every MCP/CLI write creates audit metadata where applicable.
