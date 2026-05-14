# MCP Reference

Use the Remote MCP endpoint at `/mcp` with `Authorization: Bearer <workspace-token>`. A workspace token is scoped to one workspace.

Three issuance flows, one storage shape: OAuth 2.1 + PKCE for browser MCP clients (discover via `/.well-known/oauth-protected-resource`), manual tokens from **Settings → Sessions**, or CLI tokens from `vpg login --token`. Every session shows up at the same page and can be revoked from there.

## Editing

- `create_page`: create Markdown, MDX, or HTML source in a workspace.
- `get_page`: read metadata and source.
- `get_rendered_page`: read rendered HTML, headings, frontmatter, and render mode.
- `list_page_versions`: list saved page versions.
- `create_page_snapshot`: checkpoint the current source before risky edits.
- `restore_page_version`: restore source from a saved version.
- `prepare_page_edit`: read source plus `base_version_id` and `base_content_hash`; call this before changing source.
- `validate_page_source`: validate stored or proposed Markdown/MDX/HTML.
- `patch_page`: replace exact text with optimistic concurrency.
- `update_page`: replace full source with optimistic concurrency.

## Review

- `wait_for_review`: long-poll comments/events. `timeout_ms` defaults to and is capped at 600000.
- `list_comments`: list open/resolved/all threads.
- `create_comment`: create a Markdown/MDX text comment or HTML pin comment.
- `reply_to_thread`: reply as the authenticated user without resolving. Use `complete_review_thread` for agent-attributed replies (it accepts `agent_name`, `agent_model`, `agent_session_id` and an optional `resolve`).
- `resolve_thread`: resolve without reply.
- `unresolve_thread`: reopen a resolved thread.
- `complete_review_thread`: reply with optional agent metadata and optionally resolve.
- `update_comment_anchor`: move a stale/fuzzy/manual comment anchor.
- `delete_thread`: delete an entire thread; requires admin permission.
- `list_review_events`: list workspace review events; add `page_id` to narrow to one page.

## Creation, Publishing, Navigation

- `create_page`, `create_page_from_template`
- `upload_attachment`
- `publish_page`, `publish_folder`, `update_publication`, `revoke_publication`
- `search_workspace`
- `search_pages` (page-only compatibility alias)
- `list_workspace_tree`
- `move_page`
- `invite_workspace_member`

## Session

- `list_workspaces`: list workspaces the authenticated session can access with id, name, slug, and role.
- `whoami`: return the authenticated session — user id, email, accessible workspaces, session kind (`manual` | `cli` | `oauth`), and client name.

Argument notes:

- Every MCP tool call requires an explicit `workspace_id`, including page, thread, template, and publication calls. Keep using the workspace id returned by list/tree/create responses.
- `list_review_events` requires `workspace_id`; add `page_id` to narrow to one document.
- `publish_page` and `publish_folder` update an existing publication for the same resource when one already exists.
- `update_publication` updates an existing publication by `publication_id`; use it for permission, expiry, password, and indexing changes when you already have the publication id.
- Use `search_workspace` before broad tree reads when locating existing content. It returns pages, folders, and comment threads with snippets, URLs, updated timestamps, icons, and matched fields. Pass `type: "page" | "folder" | "comment_thread" | "all"` to narrow.

## Templates

- `list_templates`, `get_template`
- `create_template`, `update_template`
- `render_template`

## Resources And Prompts

Read resources when available:

- `vpg://skills/vegastack-pages/SKILL.md`
- `vpg://skills/vegastack-pages/references/mcp.md`
- `vpg://skills/vegastack-pages/references/cli.md`
- `vpg://skills/vegastack-pages/references/comments.md`
- `vpg://skills/vegastack-pages/references/workflows.md`
- `vpg://skills/vegastack-pages/references/templates.md`
- `vpg://skills/vegastack-pages/references/security.md`
- `vpg://pages/<page_id>`
- `vpg://workspaces/<workspace_id>/tree`

Use prompts when the host supports MCP prompts:

- `vegastack_review_page`
- `vegastack_edit_page_safely`
- `vegastack_create_or_update_template`

## Active Review Loop

After creating a page, publish it with comment permission when needed, return the page URL to the user, then call `wait_for_review` with `timeout_ms: 600000`. If comments arrive, call `list_comments`, inspect `anchor_context`, patch with concurrency tokens, then `complete_review_thread` for each handled thread. Use text anchors for Markdown/MDX and point anchors for HTML pins. If the host agent is interrupted by a new user message, stop waiting and answer that message first.
