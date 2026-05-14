# MCP And CLI Specification

Status: Draft  
Date: 2026-05-10

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
vpg update check
vpg update plan
vpg update apply
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
vpg update check --json
```

## Wait Semantics

`wait` means the CLI or MCP call stays active until review input arrives or a condition is met.

Supported wait conditions:

- `first_response`: first human comment/reply arrives.
- `new_comment`: any new comment thread arrives.
- `all_threads_resolved`: every open thread is resolved.
- `timeout`: end after timeout.

Example:

```sh
vpg wait page-title-abc123 --until first_response --timeout 30m --json
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

- Streamable HTTP where supported.
- Server-Sent Events only if compatibility requires it later.

Auth:

- Workspace-scoped MCP bearer sessions created from the web app by an authenticated workspace admin.
- Tokens are shown once and can be revoked from workspace settings.
- Static bearer-token fallback is for local/debug use only and must stay disabled in production by default.
- Workspace-scoped tools after session creation.

## MCP Tools

Tool names should mirror CLI verbs but use MCP-friendly snake case:

- `create_page`
- `update_page`
- `prepare_page_edit`
- `patch_page`
- `get_page`
- `upload_attachment`
- `validate_page_source`
- `wait_for_review`
- `list_comments`
- `create_comment`
- `reply_to_thread`
- `resolve_thread`
- `unresolve_thread`
- `complete_review_thread`
- `update_comment_anchor`
- `delete_thread`
- `publish_page`
- `publish_folder`
- `update_publication`
- `revoke_publication`
- `list_review_events`
- `search_workspace`
- `search_pages` (page-only compatibility alias)
- `list_workspace_tree`
- `move_page`
- `list_templates`
- `get_template`
- `create_template`
- `update_template`
- `render_template`
- `create_page_from_template`
- `invite_workspace_member`

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
