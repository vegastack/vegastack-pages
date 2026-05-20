# MCP Reference

Remote endpoint: `/mcp`. Send `Authorization: Bearer <workspace-token>`. Tokens come from OAuth 2.1+PKCE (browser clients), **Settings → My Connections** (manual), or `vpg login` (CLI). One token = one workspace. The same bearer also authenticates the REST API the CLI uses.

Every tool except `whoami` requires `workspace_id`. Every result includes `_meta: { request_id, duration_ms }`.

## Tool surface (19 tools)

```
Reads:        fetch · search · wait_for_review · whoami
Pages:        create_page · update_page · restore_page_version · move_page
Comments:     create_comment · update_thread · delete_thread
Publications: apply_publication · delete_publication
Templates:    create_template · update_template · render_template
Other:        upload_attachment · invite_workspace_member · validate_page_source
```

## `fetch` — prefix-routed mega-read

Resource type is inferred from `resource_id` prefix: `pg_` page, `fld_` folder, `tpl_` template, `thr_` thread, `pub_` publication, `wks_` workspace, `"me"` self. Unknown prefixes throw `VPG_VALIDATION` (no silent slug fallback). Omit `resource_id` to get the workspace tree.

`include[]` valid keys (gated by resource type):

| Resource                 | Allowed includes                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `pg_…`                   | `source, rendered, versions, comments, publication, edit_tokens, history, review_events` |
| `fld_…`                  | `publication, tree`                                                                      |
| `tpl_…`                  | `properties`                                                                             |
| `wks_…` / no resource_id | `members, templates, tree`                                                               |
| `"me"`                   | `workspaces`                                                                             |

Extra params: `status: "open" | "resolved" | "all"` (filters when `include: ["comments"]`; defaults to `"all"`), `depth: number` (for `tree`).

```json
{
  "workspace_id": "wks_abc123",
  "resource_id": "pg_xyz789",
  "include": ["source", "edit_tokens", "comments"],
  "status": "open"
}
```

Response (abridged):

```json
{
  "data": {
    "kind": "page",
    "page": { "id": "pg_xyz789", "title": "Plan", "source_type": "markdown" },
    "source": "# Plan\n...",
    "edit_tokens": {
      "base_version_id": "ver_42",
      "base_content_hash": "sha256:..."
    },
    "comments": [
      /* threads, status=open only */
    ]
  },
  "_meta": { "request_id": "req_abc", "duration_ms": 31 }
}
```

## `search`

```json
{
  "workspace_id": "wks_abc123",
  "query": "deployment",
  "type": "all",
  "limit": 20
}
```

`type`: `"all" | "page" | "folder" | "comment_thread" | "comment"`.

## `wait_for_review`

Long-polls. Emits `notifications/progress`; final response carries matched events.

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "until": "first_response",
  "timeout_ms": 600000,
  "after_event_id": "evt_42"
}
```

`until`: `"first_response" | "new_comment" | "all_threads_resolved" | "timeout"`. `timeout_ms` is capped at 600000. Dedupe is anchored at `after_event_id` — reuse the last seen event id when resuming, otherwise you may re-receive events already handled.

## `whoami`

No input. Returns `user_id`, `email`, session kind (`manual | cli | oauth`), client name. Workspaces are **not** enumerated unless you call `fetch resource_id: "me" include: ["workspaces"]` (cycle 5 change).

## Page writes

### `create_page`

`title` is required and becomes the persisted page title — every surface (public /p view, editor header, search snippets, breadcrumbs) reads it from the row. Do NOT also write the title as a leading `# Title` (markdown/mdx) or `<h1>Title</h1>` (html) in `source` — the server strips a matching leading heading on persist so the title is never displayed twice.

```json
{
  "workspace_id": "wks_abc123",
  "title": "Q3 Plan",
  "source_type": "markdown",
  "source": "Plan body starts here — no leading H1.",
  "folder_path": "guides",
  "template_id": "tpl_review",
  "properties": { "owner": "platform" }
}
```

When `template_id` is provided alongside a non-empty `source`, `source` wins for the body and the template is used only to derive `source_type`. Omit `source` to get a fresh template render.

### `update_page` — one verb, three mutually exclusive modes

Always requires `base_version_id`. Combining modes is a `VPG_VALIDATION` error (e.g. `source` + `find` is rejected; no longer silently picks one).

Full replace:

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "base_version_id": "ver_42",
  "source": "# New body\n"
}
```

Find / replace:

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "base_version_id": "ver_42",
  "base_content_hash": "sha256:f00",
  "find": "old phrase",
  "replace": "new phrase",
  "expected_replacements": 1
}
```

Checkpoint-only snapshot (no content change):

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "base_version_id": "ver_42",
  "checkpoint": true,
  "checkpoint_label": "before review"
}
```

On conflict (HTTP 409): refetch `include: ["edit_tokens"]`, rebase, retry. Do not bypass.

### `restore_page_version` / `move_page`

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "version_id": "ver_old"
}
```

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "title": "New title",
  "folder_path": "guides/setup"
}
```

## Comments

### `create_comment`

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "body": "Please clarify this.",
  "anchor": {
    "selected_text": "ambiguous phrase",
    "source_start": 120,
    "source_end": 136,
    "anchor_kind": "text",
    "surface": "prose"
  }
}
```

HTML pin: `anchor_kind: "point"`, `surface: "html"`, `selector.point`. See [[comments.md]].

### `update_thread`

One tool for reply, resolve, reopen, anchor move, completion. Server order: anchor → reply → resolve. Pass `agent_name`, `agent_model`, `agent_session_id` for agent-attributed replies.

```json
{
  "workspace_id": "wks_abc123",
  "thread_id": "thr_456",
  "body": "Updated the wording.",
  "complete": true,
  "status": "resolved",
  "agent_name": "Claude",
  "agent_model": "claude-opus-4-7",
  "agent_session_id": "sess_42"
}
```

`complete: true` flags the reply as a closing reply (with agent attribution metadata) before resolving.

### `delete_thread`

```json
{ "workspace_id": "wks_abc123", "thread_id": "thr_456" }
```

Admin-only. Emits a `comment.deleted` review event.

## Publications

### `apply_publication`

Creates or updates a page/folder publication. If you pass `publication_id`, its `resource_id` must match — mismatch is a `VPG_VALIDATION` error (no silent overwrite).

```json
{
  "workspace_id": "wks_abc123",
  "resource_type": "page",
  "resource_id": "pg_xyz789",
  "permission": "comment",
  "indexing_enabled": true
}
```

`permission`: `view | comment | edit` — public viewers, public commenters, public editors. Use `clear_expires_at: true` / `clear_password: true` to remove fields on update.

### `delete_publication`

```json
{ "workspace_id": "wks_abc123", "publication_id": "pub_111" }
```

## Templates

```json
// create_template
{
  "workspace_id": "wks_abc123",
  "name": "Executive Review",
  "slug": "executive-review",
  "source_type": "markdown",
  "category": "agent",
  "builder": {
    /* see templates.md */
  },
  "properties": [
    /* see templates.md */
  ]
}
```

`update_template` accepts `template` (id or slug). `render_template` previews resolved Markdown without saving:

```json
{
  "workspace_id": "wks_abc123",
  "template": "tpl_review",
  "title": "Q3 Plan",
  "properties": { "owner": "platform" }
}
```

## Other

### `upload_attachment`

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "filename": "chart.png",
  "content_type": "image/png",
  "base64_body": "iVBORw0KGgo..."
}
```

### `invite_workspace_member`

```json
{
  "workspace_id": "wks_abc123",
  "email": "teammate@example.com",
  "display_name": "Teammate",
  "role": "editor"
}
```

Roles: `reader | commenter | editor | admin`. Sends a magic link when email is configured.

### `validate_page_source`

Read-only. Catches Mermaid 11 syntax traps, MDX, HTML issues. Run before any non-trivial `update_page`.

```json
{ "workspace_id": "wks_abc123", "page_id": "pg_xyz789" }
```

Or with proposed source:

```json
{
  "workspace_id": "wks_abc123",
  "source_type": "markdown",
  "source": "# Draft\n..."
}
```

## JSON-RPC, resources, prompts

Standard MCP envelope. An empty JSON-RPC batch returns error `-32600` (not HTTP 202).

Resources: `vpg://skills/vegastack-pages/{SKILL.md,references/*.md}`, `vpg://pages/<page_id>`, `vpg://workspaces/<workspace_id>/tree`. Prompts: `vegastack_review_page`, `vegastack_edit_page_safely`, `vegastack_create_or_update_template`.
