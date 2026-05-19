---
name: vegastack-pages
description: Use VegaStack Pages through its Remote MCP server or standalone vpg CLI for agent-authored documentation review, source editing, anchored comments, templates, publications, workspace trees, review waits, attachments, and safe publish/review workflows. Trigger when an agent needs to create, inspect, edit, validate, comment on, resolve, or template VegaStack Pages documents, or when choosing between MCP tools and the CLI.
---

# VegaStack Pages

Create, edit, comment on, publish, and template Markdown/MDX/HTML pages in a VegaStack Pages workspace. Two surfaces hit the same backend: the Remote MCP server (19 tools) and the `vpg` CLI. Pick one per workflow.

## Your first action

1. Discover identity and workspaces:
   - MCP: `fetch { "workspace_id": "<any>", "resource_id": "me", "include": ["workspaces"] }`. (`whoami` alone returns the user but no workspace list unless you pass `include: ["workspaces"]`.)
   - CLI: `vpg --agent whoami`
2. Pick a `workspace_id` (e.g. `wks_abc123`) and reuse it on every subsequent call. MCP tokens are workspace-scoped; CLI persists the active workspace via `vpg use <id>`.
3. To explore content, `fetch` with only `workspace_id` returns the tree; or `vpg --agent workspaces tree`.

## Surface selection

- Prefer **MCP** when the host harness exposes `fetch`, `update_page`, `update_thread`. It is one round-trip per call and the schemas are loaded.
- Prefer the **CLI** (`vpg --agent ...`) for shells, CI, scripts, local files, and skill installation. The CLI accepts an MCP bearer token via `--token` or `VPG_TOKEN`; the same workspace token works on both surfaces.
- Do not mix surfaces in the same mutation cycle unless coordinating an explicit migration.

## Tool surface at a glance

MCP (19 tools):

```
Reads:        fetch · search · wait_for_review · whoami
Pages:        create_page · update_page · restore_page_version · move_page
Comments:     create_comment · update_thread · delete_thread
Publications: apply_publication · delete_publication
Templates:    create_template · update_template · render_template
Other:        upload_attachment · invite_workspace_member · validate_page_source
```

CLI (noun-first):

```
Top-level: login / logout / whoami / use / search / events / validate / deploy / doctor / update / completions
Nouns:     pages / comments / publish / templates / workspaces / attachments / skills
```

Always pass `--agent` from an agent harness. See [[references/cli.md]] for the JSON envelope and exit codes.

## The mandatory edit cycle

Page edits are optimistic-concurrency. Stale tokens fail with `VPG_CONFLICT` (HTTP 409, CLI exit 6).

```
fetch (include: ["source", "edit_tokens"])
   -> validate_page_source           (catch Mermaid / MDX traps before saving)
   -> update_page (find/replace preferred; full source / checkpoint as needed)
   -> on conflict: refetch edit_tokens, recompute, retry
```

CLI equivalent:

```sh
vpg --agent pages get pg_abc123 --include source,edit_tokens
vpg --agent validate --page pg_abc123
vpg --agent pages update pg_abc123 \
  --base-version-id ver_42 --base-content-hash sha256:f00 \
  --find "old wording" --replace "new wording" --expected-replacements 1
```

## Review loop

1. Create or update the page.
2. If the reviewer is outside the workspace, `apply_publication` with `permission: "comment"`.
3. Tell the user the public URL; announce a wait window (up to 10 min).
4. `wait_for_review` (MCP, `timeout_ms` max 600000) or `vpg pages wait <page> --until first-response --timeout 600` (CLI, NDJSON under `--agent`).
5. When events arrive: `fetch include: ["comments","source","edit_tokens"]`, patch with `update_page`, reply via `update_thread` (set `agent_name`, `agent_model`, `agent_session_id` for attribution), then `status: "resolved"`.
6. If the host harness delivers a new user message mid-wait, abandon the wait, answer the user, and only resume if still relevant.

## References

Load only the file you need:

- [[references/mcp.md]] — 19 MCP tools, schemas, conflict recovery.
- [[references/cli.md]] — noun-first CLI, `--agent` envelope, exit codes.
- [[references/comments.md]] — text vs point anchors, `coerceCommentAnchor` rules.
- [[references/workflows.md]] — end-to-end review, conflict recovery, interruptions.
- [[references/templates.md]] — builder shape, frontmatter field types.
- [[references/security.md]] — token scope, concurrency, destructive ops, public-publication permission model.

## Hard rules

- Never write tokens into pages, templates, logs, or generated files. Use `VPG_TOKEN`, `vpg login`, or the host secret store.
- Never call `update_page` without a fresh `base_version_id` from `fetch include: ["edit_tokens"]`.
- Never set both `source` and `find` on `update_page` — the server rejects it (`VPG_VALIDATION`).
- Never pass `publication_id` together with a `resource_id` that doesn't own it — the server rejects it.
- Never busy-poll `fetch` for comments. Use `wait_for_review`.
- Destructive CLI ops (`pages restore`, `publish revoke`, `comments delete`) under `--agent` require `--yes` or exit 2.
