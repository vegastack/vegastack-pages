export const mcpInstructions = `# VegaStack Pages MCP

You are connected to a VegaStack Pages workspace. Use the tools below to read, edit, comment on, publish, and template Markdown/MDX/HTML pages.

## Authentication and scope

- Every tool requires \`workspace_id\`. The current session is workspace-scoped; pass the same id consistently. If the user has not named one, call \`fetch\` with \`resource_id: "me"\` and \`include: ["workspaces"]\` (or just \`whoami\`) and pick an explicit choice.
- \`whoami\` returns the current user, accessible workspaces, and session kind. Call it once at the start of a session if you need to discover identity or workspace ids.

## Reads — one tool for everything

\`fetch\` is the only read tool you need for resource lookups. The resource type is inferred from the \`resource_id\` prefix:

- \`pg_…\` → page
- \`fld_…\` → folder
- \`tpl_…\` → template
- \`thr_…\` → comment thread
- \`pub_…\` → publication
- \`wks_…\` → workspace
- \`"me"\` → the authenticated identity

Use the \`include\` array to ask for sub-data:

- Pages: \`source\`, \`rendered\`, \`versions\`, \`comments\`, \`publication\`, \`edit_tokens\`, \`history\`, \`review_events\`
- Templates: \`properties\`
- Workspaces: \`members\`, \`templates\`, \`tree\`
- \`me\`: \`workspaces\`

\`search\` is a separate tool because it spans the whole workspace.

## Mandatory edit workflow

Page edits use optimistic concurrency. Stale tokens fail with 409. The safe pattern:

1. \`fetch\` with \`include: ["source", "edit_tokens"]\` returns the live source, \`base_version_id\`, and \`base_content_hash\`. (This replaces the old \`prepare_page_edit\` tool.)
2. \`validate_page_source\` checks for Markdown/MDX/HTML/Mermaid traps; fix issues before saving.
3. Apply the change with \`update_page\` in one of three modes:
   - **Find/replace** (preferred for narrow edits): pass \`find\` and \`replace\` (plus optional \`replace_all\`, \`expected_replacements\`). This is the old \`patch_page\`.
   - **Full source replace**: pass \`source\`.
   - **Checkpoint-only** (no source change, just a labeled snapshot for rollback): pass \`checkpoint: true\` with no \`source\` or \`find\`. This is the old \`create_page_snapshot\`.
4. On 409 or stale-hash errors, refetch via \`fetch\` and reapply.

Use \`update_page\` with \`checkpoint: true\` before risky edits if you may need to roll back. \`fetch\` with \`include: ["versions"]\` lists saved versions; \`restore_page_version\` reverts.

## Comments and review

- Read threads via \`fetch\` with \`include: ["comments"]\`. Create via \`create_comment\`.
- Mutate via \`update_thread\` — one tool covers reply (\`body\`), resolve (\`status: "resolved"\` or \`resolve: true\`), reopen (\`status: "open"\`), anchor moves (\`anchor\`), and completion (\`complete: true\` writes a closing reply and optionally resolves in one call).
- For agent-attributed replies (Claude, Cursor, vpg, ...) pass \`agent_name\`, \`agent_model\`, \`agent_session_id\` to \`update_thread\`.
- Anchors: Markdown/MDX comments use text anchors (\`selected_text\` + offsets/context). HTML pin comments use point anchors (\`anchor_kind: point\`, \`surface: html\`, \`selector.point\`). Move a stale anchor by passing a new \`anchor\` to \`update_thread\`.
- Review loop: \`apply_publication\` with comment permission if external reviewers, then \`wait_for_review\` (timeout up to 600000ms). When events arrive, patch the source via \`update_page\` find/replace, then \`update_thread\` with \`complete: true\` for each handled thread.

## Templates

- \`fetch\` with a workspace_id and \`include: ["templates"]\` lists templates. Use \`fetch tpl_…\` to inspect a specific template's builder + property spec.
- \`create_template\` / \`update_template\` accept \`builder.sections\` with level 2/3/4 headings plus a typed \`properties\` array (text, longtext, number, date, datetime, boolean, select, tags) and required/default/options.
- \`render_template\` previews resolved Markdown without creating a page.
- \`create_page\` with \`template_id\` materializes a page from a template (this is the old \`create_page_from_template\`). Required properties must be supplied.

## Publishing

- \`apply_publication\` creates or updates page/folder public URLs. Handles both \`resource_type: "page"\` and \`resource_type: "folder"\`. \`permission\` is one of \`view | comment | edit\`. Confirm with the user before publishing anything that was not already public — revocation uses \`delete_publication\`.

## Attachments

- \`upload_attachment\` accepts base64 with a configurable byte budget. Always set an accurate \`content_type\`.

## Members

- \`invite_workspace_member\` creates the user if missing, adds them at the requested role (reader | commenter | editor | admin), and emails a magic link when email is configured.

## CLI parity

MCP and \`vpg\` share the same backend. The CLI mirrors this tool surface: \`vpg pages create\`, \`vpg comments resolve\`, \`vpg publish page\`, etc. Pick MCP when connected; pick \`vpg --agent\` for shell, CI, or local-file workflows.

## Don'ts

- Don't busy-poll \`fetch\` for new comments — use \`wait_for_review\`.
- Don't \`update_page\` without a fresh \`base_version_id\` from \`fetch\` with \`include: ["edit_tokens"]\`. On a 409 conflict, refetch and reapply.
- Don't pass both \`source\` and \`find\` to \`update_page\` — pick one mode.
- Don't infer \`workspace_id\` — ask if it isn't already established.
`;

export const mcpInstructionsMaxBytes = 8 * 1024;
