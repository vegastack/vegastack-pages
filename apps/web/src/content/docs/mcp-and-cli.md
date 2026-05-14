---
title: MCP and CLI
description: Create, edit, review, publish, and template pages from an MCP client or the vpg CLI.
category: Agents
order: 10
lastUpdated: 2026-05-14
---

VegaStack Pages exposes review workflows through a Remote MCP endpoint and a Rust CLI. MCP is the primary agent surface. The CLI is useful from a shell or CI job when the target deployment accepts the bearer token you provide.

## MCP endpoint

The Remote MCP server is mounted at `/mcp` on the same app.

1. Sign in to the web app.
2. Open **Settings -> MCP**.
3. Create a workspace-scoped session.
4. Send requests to the returned endpoint with `Authorization: Bearer <token>`.

Tokens are shown once and can be revoked from the same settings page.

Managed endpoint:

```text
https://pages.vegastack.com/mcp
```

Self-hosted endpoint:

```text
https://pages.example.com/mcp
```

`wait_for_review` accepts `timeout_ms` in milliseconds and defaults to/caps at 10 minutes per call.

Every workspace-scoped MCP tool call must include `workspace_id`, even when the token is scoped to one workspace. Page, thread, template, publication, and event tools use that value as an explicit guard against cross-workspace mistakes.

Current tools:

- `create_page`, `get_page`, `prepare_page_edit`, `update_page`, `patch_page`
- `validate_page_source`
- `upload_attachment`
- `wait_for_review` (see [wait conditions](/docs/wait-conditions))
- `list_comments`, `create_comment`, `reply_to_thread`, `complete_review_thread`
- `resolve_thread`, `unresolve_thread`, `update_comment_anchor`, `delete_thread`
- `list_review_events`
- `publish_page`, `publish_folder`, `update_publication`, `revoke_publication`
- workspace search for pages, folders, and comment threads
- page-only search compatibility
- `list_workspace_tree`, `move_page`
- `invite_workspace_member`
- `list_templates`, `get_template`, `create_template`, `update_template`
- `render_template`, `create_page_from_template`

Common page loop:

```js
await mcp.call("create_page_from_template", {
  workspace_id: "wks_123",
  template_id: "prd",
  title: "Search redesign",
  properties: { owner: "platform" },
});

await mcp.call("wait_for_review", {
  workspace_id: "wks_123",
  page_id: "pg_123",
  until: "first_response",
  timeout_ms: 600000,
});

await mcp.call("patch_page", {
  workspace_id: "wks_123",
  page_id: "pg_123",
  base_version_id: "ver_123",
  find: "old sentence",
  replace: "new sentence",
  expected_replacements: 1,
});
```

## CLI

The CLI is a Rust binary distributed through the `@vegastack/pages` npm package. Two aliases work identically:

```sh
vpg --help
vegastack-pages --help
```

Examples:

```sh
vpg --base-url https://pages.vegastack.com --workspace wks_123 create --file ./plan.md --title "Plan"
vpg --base-url https://pages.vegastack.com --workspace wks_123 create --template prd --title "Search redesign" --set owner=platform
vpg --base-url https://pages.vegastack.com --workspace wks_123 wait pg_123 --until first-response
vpg --base-url https://pages.vegastack.com --workspace wks_123 publish-page pg_123 --permission comment
```

For equivalent shell workflows, call the standalone CLI commands:

```sh
vpg --base-url https://pages.example.com --workspace wks_123 pages prepare-edit pg_123
vpg --base-url https://pages.example.com --workspace wks_123 pages patch pg_123 --base-version-id ver_123 --find old --replace new
vpg --base-url https://pages.example.com --workspace wks_123 pages validate --page pg_123
vpg --base-url https://pages.example.com --workspace wks_123 complete-thread cmt_123 --body "Fixed." --resolve --agent-name Codex
vpg --base-url https://pages.example.com --workspace wks_123 events --page pg_123
vpg --base-url https://pages.example.com --workspace wks_123 search "runbook" --type page
vpg --base-url https://pages.example.com --workspace wks_123 tree
vpg --base-url https://pages.example.com --workspace wks_123 export
vpg --base-url https://pages.example.com --workspace wks_123 revoke-publication pub_123
vpg --base-url https://pages.example.com --workspace wks_123 templates create --args-file ./template.json
vpg --base-url https://pages.example.com --workspace wks_123 templates update tpl_123 --args-file ./template-update.json
```

The CLI uses standalone API routes, not the MCP transport. It does not require
an MCP client or MCP server calls, and it covers the same page, review, comment,
publication, template, tree, attachment, and member workflows. Bearer tokens are
resolved server-side and remain scoped to the workspace that issued them.
Pass `--workspace <workspace_id>` or run `vpg use <workspace_id>` before
workspace-scoped commands; the CLI includes `workspace_id` in every API call.

Authentication is explicit: use `--token`, `VPG_TOKEN`, or `vpg login --token <token> --workspace <workspace-id>`. Run `vpg <command> --help` for exact flags.

## Agent skills

The canonical portable agent skill is checked into the repository at `skills/vegastack-pages`. The CLI embeds that top-level skill at build time so installed npm binaries can still install it without a source checkout:

```sh
vpg skills doctor
vpg skills install --agent all --scope user
vpg skills update --agent all --scope user
vpg skills install --agent codex --scope project
vpg skills install --agent cursor --scope project
```

Codex and Claude receive the native `SKILL.md` bundle. Cursor receives a `.mdc` rules adapter. Gemini CLI receives an extension adapter. MCP clients can read the same guidance as resources under `vpg://skills/vegastack-pages/...` and can request prompts such as `vegastack_edit_page_safely`. npm installs do not mutate agent config automatically; run `vpg skills install --agent all --scope user` once, and run `vpg skills update --agent all --scope user` after package updates.

MCP exposes skill guidance to the connected client, but it does not install files globally on the user's machine. Use the CLI skill installer for global Codex/Claude/Cursor/Gemini/etc. files.

## Deploy helper

`vpg deploy` shells out to this repository's `pnpm deploy:cloudflare` script. Run it from a source checkout, not as a standalone installer.
