---
name: vegastack-pages
description: Use VegaStack Pages through its Remote MCP server or standalone vpg CLI for agent-authored documentation review, source editing, anchored comments, templates, publications, workspace trees, review waits, attachments, and safe publish/review workflows. Trigger when an agent needs to create, inspect, edit, validate, comment on, resolve, or template VegaStack Pages documents, or when choosing between MCP tools and the CLI.
---

# VegaStack Pages

Use the MCP server when it is connected in the current agent harness. Use the `vpg` CLI when MCP tools are unavailable or the task is running in a shell/CI context. Do not mix MCP and CLI calls in the same workflow unless the user asks; both surfaces mutate the same pages and comments.

## Surface Selection

1. If MCP tools named `create_page`, `prepare_page_edit`, `patch_page`, or `update_thread` are available, use MCP.
2. If no MCP tools are available, use the standalone `vpg` CLI with `--base-url`, `--workspace`, and either `--token` or stored login. CLI workflows do not require MCP.
3. If both are available, prefer MCP for agent review workflows and the CLI for local files, scripts, CI, exports, or installation tasks.
4. Never store tokens in this skill or in generated documents. Use the host agent's secret storage, `VPG_TOKEN`, or `vpg login --token`.

## Review Loop

When creating a document for human review:

1. Create or update the page.
2. Publish the page with comment permission when the reviewer is not already in the workspace.
3. Tell the user the page public URL and that you are waiting for review for up to 10 minutes.
4. Wait for review comments/events.
5. When comments arrive, immediately inspect them, patch source safely, reply to each addressed thread, and resolve only threads that are actually handled.
6. If the wait times out, report the link and the current review state.

If the host agent receives a new user message while waiting, treat that as an interruption from the harness: stop waiting, answer the user, and resume the review loop only if still relevant.

## Required Workflow

For edits, always fetch the live source and concurrency tokens first.

MCP:

```text
prepare_page_edit -> validate_page_source -> patch_page or update_page -> update_thread
```

CLI:

```sh
vpg pages prepare-edit <page>
vpg pages validate --page <page>
vpg pages patch <page> --base-version-id <version> --base-content-hash <hash> --find "old" --replace "new"
vpg complete-thread <thread> --body "Done." --resolve --agent-name "<agent>"
```

Prefer `patch_page` / `vpg pages patch` for narrow edits. Use full source updates only when rewriting a whole document. Treat stale version or content hash errors as a signal to refetch and reapply.

## References

Read only the file needed for the task:

- `references/mcp.md` for MCP tools, resources, prompts, and wait behavior.
- `references/cli.md` for CLI commands, auth, installation, and shell examples.
- `references/comments.md` for Markdown/MDX text anchors and HTML pin comments.
- `references/workflows.md` for end-to-end review loops.
- `references/templates.md` for template builder and frontmatter field structure.
- `references/security.md` for permissions, token handling, and conflict rules.
