---
title: MCP and CLI
description: Create, edit, review, publish, and template pages from an MCP client or the vpg CLI.
category: Agents
order: 10
lastUpdated: 2026-05-14
---

VegaStack Pages exposes review workflows through a Remote MCP endpoint and a Rust CLI. MCP is the primary agent surface. The CLI is useful from a shell or CI job when the target deployment accepts a bearer token.

## MCP endpoint

The Remote MCP server is mounted at `/mcp` on the same app and implements the MCP 2025-06-18 Streamable HTTP transport.

Managed endpoint:

```text
https://pages.vegastack.com/mcp
```

Self-hosted endpoint:

```text
https://pages.example.com/mcp
```

### Authentication

The server accepts a bearer token on `Authorization: Bearer <token>`. Tokens come from one of three flows; all three land in the same `Sessions` table and behave identically once issued.

1. **Browser OAuth — MCP clients (Claude.ai, ChatGPT, Cursor remote, …).** The client discovers the auth server via `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, registers itself with `POST /oauth/register` (RFC 7591), runs an OAuth 2.1 authorization-code flow with PKCE S256 (RFC 7636), and exchanges the code at `/oauth/token`. The server issues a 1-hour access token and a 60-day rotating refresh token. No setup in the web app is required for this path — pasting the endpoint URL is enough.
2. **Browser OAuth — `vpg` CLI (RFC 8628 device-code).** `vpg login` with no `--token` opens a verification URL in your browser, you pick a workspace and click **Allow**, the CLI polls `/oauth/token` and receives the access token. Uses the baked-in well-known client `oac_vpg_cli`, so no dynamic registration is needed. Works headless: the URL prints to the terminal — open it on any device (laptop, phone). Sessions issued this way appear under **Settings → Sessions** with `kind=oauth`.
3. **Manual bearer.** Sign in to the web app, open **Settings → Sessions**, click **Create session**, copy the token. Use it for headless agents, CI runners, MCP-over-stdio bridges, or any environment where the device-code flow isn't desirable. Tokens are shown once and revocable from the same page. Pass via `vpg login --token <tok>` or `VPG_TOKEN`; CLI-stored tokens appear with `kind=cli`.

The `/mcp` endpoint returns `WWW-Authenticate: Bearer realm="VegaStack Pages MCP", resource_metadata="…/.well-known/oauth-protected-resource", error="invalid_token"` on 401 so spec-compliant browser clients can self-onboard.

### initialize.instructions

After `initialize`, the server sends a curated instruction block (≤8 KB) describing the safe edit workflow, agent-attribution rules, and review-loop pattern. MCP clients that honor `initialize.instructions` inject it into the model's system prompt automatically; clients that don't can still discover the same content under MCP resources at `vpg://skills/vegastack-pages/SKILL.md`.

### Workspace scoping

Every workspace-scoped MCP tool call must include `workspace_id`. The token is workspace-scoped server-side, but the explicit id is an explicit guard against cross-workspace mistakes. Use `list_workspaces` once at session start to discover the ids your session can access.

### Tool surface

| Category  | Tools                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session   | `list_workspaces`, `whoami`                                                                                                                                                                             |
| Create    | `create_page`, `create_page_from_template`, `upload_attachment`                                                                                                                                         |
| Read      | `get_page`, `get_rendered_page`, `list_page_versions`, `list_workspace_tree`                                                                                                                            |
| Edit      | `prepare_page_edit`, `patch_page`, `update_page`, `validate_page_source`, `move_page`, `create_page_snapshot`, `restore_page_version`                                                                   |
| Review    | `wait_for_review`, `list_comments`, `create_comment`, `reply_to_thread`, `complete_review_thread`, `resolve_thread`, `unresolve_thread`, `update_comment_anchor`, `delete_thread`, `list_review_events` |
| Publish   | `publish_page`, `publish_folder`, `update_publication`, `revoke_publication`                                                                                                                            |
| Search    | `search_workspace`, `search_pages`                                                                                                                                                                      |
| Templates | `list_templates`, `get_template`, `create_template`, `update_template`, `render_template`                                                                                                               |
| Members   | `invite_workspace_member`                                                                                                                                                                               |

`reply_to_thread` posts a reply as the authenticated user. For agent-attributed replies use `complete_review_thread`, which accepts `agent_name`, `agent_model`, and `agent_session_id` and can resolve the thread in the same call. `wait_for_review` accepts `timeout_ms` in milliseconds (default and cap: 10 minutes) and `after_event_id` for cursor-based polling.

### Common page loop

```js
const { workspaces } = await mcp.call("list_workspaces", {});
const workspaceId = workspaces[0].id;

await mcp.call("create_page_from_template", {
  workspace_id: workspaceId,
  template: "prd",
  title: "Search redesign",
  properties: { owner: "platform" },
});

await mcp.call("wait_for_review", {
  workspace_id: workspaceId,
  page_id: "pg_123",
  until: "first_response",
  timeout_ms: 600000,
});

const prep = await mcp.call("prepare_page_edit", {
  workspace_id: workspaceId,
  page_id: "pg_123",
});

await mcp.call("patch_page", {
  workspace_id: workspaceId,
  page_id: "pg_123",
  base_version_id: prep.base_version_id,
  base_content_hash: prep.base_content_hash,
  find: "old sentence",
  replace: "new sentence",
  expected_replacements: 1,
});
```

## CLI

The CLI is a Rust binary distributed through the `@vegastack/pages` npm package. Two aliases run the same binary:

```sh
vpg --help
vegastack-pages --help
```

Examples:

```sh
vpg --base-url https://pages.vegastack.com --workspace wks_123 create --file ./plan.md --title "Plan"
vpg --base-url https://pages.vegastack.com --workspace wks_123 create --template prd --title "Search redesign" --set owner=platform
vpg --base-url https://pages.vegastack.com --workspace wks_123 wait pg_123 --until first-response --after-id evt_42
vpg --base-url https://pages.vegastack.com --workspace wks_123 publish-page pg_123 --permission comment
vpg --base-url https://pages.vegastack.com --workspace wks_123 whoami
vpg --base-url https://pages.vegastack.com workspaces
```

Equivalent surgical-edit workflow:

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

The CLI calls the same standalone API routes the web app uses; it does not require an MCP client. Bearer tokens are workspace-scoped server-side. Pass `--workspace <workspace_id>` or run `vpg use <workspace_id>` before workspace-scoped commands; the CLI includes `workspace_id` in every API call.

Authentication is explicit: `vpg login` (browser device-code, default), `vpg login --token <token>`, `VPG_TOKEN` env, or `--token` per-call. Run `vpg <command> --help` for exact flags.

### MCP/CLI parity

Every MCP tool has a matching CLI command. `vpg wait` emits status `matched` (was `condition_met`) and accepts `--after-id <event_id>` to mirror `wait_for_review.after_event_id`. CLI-only commands are operator-scoped (`login`, `logout`, `use`, `doctor`, `deploy`, `export`, `update`, `skills`).

## Active sessions

Open **Settings → Sessions** to see every active token issued for a workspace.

- **Mine** lists OAuth, manual, and CLI sessions issued for the signed-in user.
- **Workspace** (admin only) lists every active session in the workspace.

Each row shows the recognized vendor (Claude, ChatGPT, Cursor, Windsurf, Continue, Cline, Codex, vpg CLI, …), kind chip (`oauth | manual | cli`), last-seen timestamp, expiry, and a one-click revoke. Revoked tokens stop working on the next request.

## Agent skills

The canonical portable agent skill is checked into the repository at `skills/vegastack-pages`. The CLI embeds the bundle at build time so installed npm binaries can install it without a source checkout:

```sh
vpg skills doctor
vpg skills install --agent all --scope user
vpg skills update --agent all --scope user
vpg skills install --agent codex --scope project
vpg skills install --agent cursor --scope project
```

Codex and Claude receive the native `SKILL.md` bundle. Cursor receives a `.mdc` rules adapter. Gemini CLI receives an extension adapter. MCP clients can read the same guidance as resources under `vpg://skills/vegastack-pages/...` and request prompts such as `vegastack_edit_page_safely`. npm installs do not mutate agent config automatically; run `vpg skills install --agent all --scope user` once and `vpg skills update --agent all --scope user` after package updates.

## Deploy helper

`vpg deploy` shells out to this repository's `pnpm deploy:cloudflare` script. Run it from a source checkout, not as a standalone installer.
