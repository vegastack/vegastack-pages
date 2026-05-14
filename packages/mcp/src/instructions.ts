export const mcpInstructions = `# VegaStack Pages MCP

You are connected to a VegaStack Pages workspace. Use the tools below to read, edit, comment on, publish, and template Markdown/MDX/HTML pages.

## Authentication and scope

- Every tool requires \`workspace_id\`. The current session is workspace-scoped; pass the same id consistently. If the user has not named one, call \`list_workspaces\` and pick the explicit choice.
- \`whoami\` returns the current user, accessible workspaces, and session kind. Call it once at the start of a session if you need to discover identity or workspace ids.

## Mandatory edit workflow

Page edits use optimistic concurrency. Stale tokens fail with 409. The safe pattern:

1. \`prepare_page_edit\` returns the live source, \`base_version_id\`, and \`base_content_hash\`.
2. \`validate_page_source\` checks for Markdown/MDX/HTML/Mermaid traps; fix issues before saving.
3. Apply the change with either:
   - \`patch_page\` for surgical \`find\`/\`replace\` edits with \`expected_replacements\` (preferred for narrow changes).
   - \`update_page\` for whole-file rewrites.
4. On 409 or stale-hash errors, refetch with \`prepare_page_edit\` and reapply.

Use \`create_page_snapshot\` before risky edits if you may need to roll back. \`list_page_versions\` and \`restore_page_version\` cover recovery.

## Comments and review

- Threads: \`list_comments\`, \`create_comment\`, \`reply_to_thread\` (replies as the authenticated user), \`resolve_thread\`, \`unresolve_thread\`, \`delete_thread\`.
- For agent-attributed replies (Claude, Cursor, vpg, ...) always use \`complete_review_thread\` — it accepts \`agent_name\`, \`agent_model\`, \`agent_session_id\` and optionally resolves in one call.
- Anchors: Markdown/MDX comments use text anchors (\`selected_text\` + offsets/context). HTML pin comments use point anchors (\`anchor_kind: point\`, \`surface: html\`, \`selector.point\`). Use \`update_comment_anchor\` after fixing a fuzzy/stale anchor.
- Review loop: after the user asks you to ship work for review, \`publish_page\` with comment permission if external reviewers, then \`wait_for_review\` (timeout up to 600000ms). When events arrive, act on them — patch the source, reply, and \`complete_review_thread\` with \`resolve\` for each handled thread.

## Templates

- \`list_templates\` then \`get_template\` to see the structured builder, sections, and frontmatter properties.
- \`create_template\` / \`update_template\` accept \`builder.sections\` with level 2/3/4 headings plus a typed \`properties\` array (text, longtext, number, date, datetime, boolean, select, tags) and required/default/options.
- \`render_template\` previews resolved Markdown without creating a page; \`create_page_from_template\` materializes one. Required properties must be supplied.

## Publishing

- \`publish_page\` and \`publish_folder\` issue canonical public URLs. \`permission\` is one of \`view | comment | edit\`. Confirm with the user before publishing anything that was not already public — revocation requires \`revoke_publication\`.
- \`update_publication\` can change permission, expiry, password, or indexing.

## Search and navigation

- \`search_workspace\` covers pages, folders, and comment threads. Use \`search_pages\` for the pages-only fast path. Use \`list_workspace_tree\` to navigate folder structure. Use \`move_page\` to rename or change folder path.

## Attachments

- \`upload_attachment\` accepts base64 with a configurable byte budget. Always set an accurate \`content_type\`.

## Members

- \`invite_workspace_member\` creates the user if missing, adds them at the requested role (reader | commenter | editor | admin), and emails a magic link when email is configured.

## CLI parity

Every MCP tool has a matching \`vpg\` CLI subcommand (prepare-edit, patch, validate, publish-page, complete-thread, wait, ...). Pick MCP when connected; pick \`vpg\` for shell, CI, or local-file workflows. Do not mix the two in the same flow unless the user asks.

## Don'ts

- Don't busy-poll \`list_comments\` — use \`wait_for_review\`.
- Don't pass \`agent_name\` to \`reply_to_thread\`; use \`complete_review_thread\` instead.
- Don't \`update_page\` without a fresh \`base_version_id\` from \`prepare_page_edit\`.
- Don't infer \`workspace_id\` — ask if it isn't already established.
`;

export const mcpInstructionsMaxBytes = 8 * 1024;
