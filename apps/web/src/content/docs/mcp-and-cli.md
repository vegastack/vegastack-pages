---
title: MCP and CLI
description: Create, edit, review, publish, and template pages from an MCP client or the vpg CLI.
category: Agents
order: 10
lastUpdated: 2026-05-20
---

VegaStack Pages exposes review workflows through a Remote MCP server and a Rust CLI. Both surfaces are Notion-style — verb-noun MCP tools with one mega-`fetch` for reads, noun-first CLI hierarchy (`vpg <noun> <verb>`).

The CLI hits the same standalone HTTP API the web app uses; it does not require an MCP client. Sessions issued by either flow appear under **Settings → My Connections** and can be revoked there.

## MCP endpoint

The Remote MCP server is mounted at `/mcp` on the same app and implements the MCP 2025-11-25 Streamable HTTP transport.

```text
https://pages.vegastack.com/mcp                # managed
https://pages.example.com/mcp                  # self-hosted
http://127.0.0.1:4322/mcp                      # local dev
```

### Authentication

The server accepts a bearer token via `Authorization: Bearer <token>`. Three flows feed the same `Sessions` table:

1. **Browser OAuth (MCP clients — Claude.ai, ChatGPT, Cursor remote, …).** The client discovers the authorization server via `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, dynamically registers itself via `POST /oauth/register` (RFC 7591), runs an OAuth 2.1 authorization-code flow with PKCE S256 (RFC 7636), and exchanges the code at `/oauth/token`. 1-hour access tokens, 60-day rotating refresh tokens. Pasting the endpoint URL is all the user has to do.
2. **`vpg login` device-code flow.** `vpg login` with no `--token` starts an RFC 8628 device-code flow against `/oauth/device` and `/oauth/token`, opens the verification URL in the browser, and stores the access token in the OS keychain. `--no-browser` skips the auto-launch (URL still prints — works over SSH).
3. **Manual bearer.** Open **Settings → My Connections**, click **Create token**, copy the value. Use it as `Authorization: Bearer <token>` or pass `vpg login --token <tok>` / `VPG_TOKEN`. Workspace-scoped server-side.

The `/mcp` endpoint returns `WWW-Authenticate: Bearer realm="VegaStack Pages MCP", resource_metadata="…/.well-known/oauth-protected-resource", error="invalid_token"` on 401 so spec-compliant browser clients can self-onboard.

Bearer-authenticated requests are exempt from CSRF (no cookie ambient authority), so the CLI can write against `/api/*` routes the web app shares.

### initialize.instructions

After `initialize`, the server sends a curated instruction block (≤8 KB) covering the safe-edit workflow, agent-attribution rules, and review-loop pattern. Clients that honor `initialize.instructions` inject it into the model's system prompt; clients that don't can read the same content from `vpg://skills/vegastack-pages/SKILL.md`.

### Workspace scoping

Every workspace-scoped tool call must include `workspace_id`. The token is workspace-scoped server-side; the explicit id is a guard against cross-workspace mistakes. Call `fetch` once with `include=["workspaces"]` and no `resource_id` (or `resource_id: "me"`) to discover ids.

## MCP tool surface

19 tools total. One mega-`fetch` for reads + verb-noun writes. The reads collapse what used to be ten separate `get_*`/`list_*` tools.

| Category   | Tools                                                             |
| ---------- | ----------------------------------------------------------------- |
| Reads      | `fetch`, `search`, `wait_for_review`, `whoami`                    |
| Page write | `create_page`, `update_page`, `restore_page_version`, `move_page` |
| Comments   | `create_comment`, `update_thread`, `delete_thread`                |
| Publish    | `apply_publication`, `delete_publication`                         |
| Templates  | `create_template`, `update_template`, `render_template`           |
| Attachment | `upload_attachment`                                               |
| Workspace  | `invite_workspace_member`, `validate_page_source`                 |

### `fetch` — one read tool for every resource

`fetch` routes by the `resource_id` prefix: `pg_` → page, `fld_` → folder, `tpl_` → template, `thr_` → comment thread, `pub_` → publication, `wks_` → workspace, `"me"` → authenticated identity. An unknown prefix is rejected — there is no silent slug fallback.

Omit `resource_id` and pass `include=["workspaces"]` to list workspaces the session can access.

`include[]` enum:

| Key             | Use on                         | Returns                                                     |
| --------------- | ------------------------------ | ----------------------------------------------------------- |
| `metadata`      | page, folder, template, thread | Core row (default if `include` is empty for pages)          |
| `source`        | page                           | Live source string (default for pages alongside `metadata`) |
| `rendered`      | page                           | Pre-rendered HTML                                           |
| `versions`      | page                           | Version history                                             |
| `comments`      | page                           | Comment threads (filter with `status`)                      |
| `publication`   | page, folder                   | Active publication, if any                                  |
| `edit_tokens`   | page                           | `base_version_id` + `base_content_hash` for `update_page`   |
| `members`       | workspace                      | Member list                                                 |
| `properties`    | template                       | Frontmatter property spec                                   |
| `history`       | page                           | Audit timeline                                              |
| `review_events` | page                           | Review-event stream tail                                    |
| `workspaces`    | `me` or omitted `resource_id`  | All workspaces visible to the session                       |
| `templates`     | workspace                      | Template list                                               |
| `tree`          | workspace                      | Folder/page tree (use `depth` to limit)                     |

JSON-RPC shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "fetch",
    "arguments": {
      "workspace_id": "wks_123",
      "resource_id": "pg_abc",
      "include": ["source", "edit_tokens", "comments"],
      "status": "open"
    }
  }
}
```

### `update_page` — 3 mutually-exclusive modes

All three require `base_version_id` for optimistic concurrency. Re-fetch via `fetch` with `include=["edit_tokens"]` whenever the version mismatches.

| Mode            | Required fields                                                | Optional                                                                                      |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Full source     | `source`                                                       | `checkpoint`, `checkpoint_label`, `allow_noop`, `base_content_hash`                           |
| Find / replace  | `find`, `replace`                                              | `replace_all`, `expected_replacements`, `checkpoint`, `checkpoint_label`, `base_content_hash` |
| Checkpoint only | `checkpoint: true` (and **no** `source`, `find`, or `replace`) | `checkpoint_label`                                                                            |

Fields not relevant to the chosen mode are omitted on the wire (not sent as `null`) so strict server validators accept the call.

### `update_thread` — one tool, several ops

Pass any combination; the server applies anchor → reply → resolve in that order:

| Op                | Field                                                                           |
| ----------------- | ------------------------------------------------------------------------------- |
| Reply             | `body`                                                                          |
| Resolve / reopen  | `status: "resolved" \| "open"` or `resolve: true`                               |
| Move anchor       | `anchor: {…}` (same shape as `create_comment`)                                  |
| Completion reply  | `complete: true` with `body` (writes a closing reply, then optionally resolves) |
| Agent attribution | `agent_name`, `agent_model`, `agent_session_id`                                 |

### `apply_publication` — page + folder

`resource_type: "page" | "folder"` selects which subtree gets a publication. Pass `publication_id` to update an existing one; omit to create. The server rejects calls where `publication_id` is set but `resource_id` mismatches the target — pure cutover, no silent drift.

### Read example — combined fetch

```json
{
  "name": "fetch",
  "arguments": {
    "workspace_id": "wks_123",
    "resource_id": "pg_abc",
    "include": ["source", "edit_tokens", "comments", "publication"],
    "status": "all"
  }
}
```

One call returns enough to read, edit, and re-render the page.

### Common page loop

```js
const me = await mcp.call("fetch", {
  workspace_id: "wks_demo",
  resource_id: "me",
  include: ["workspaces"],
});
const workspaceId = me.workspaces[0].id;

await mcp.call("create_page", {
  workspace_id: workspaceId,
  title: "Search redesign",
  template_id: "prd",
  properties: { owner: "platform" },
});

await mcp.call("wait_for_review", {
  workspace_id: workspaceId,
  page_id: "pg_123",
  until: "first_response",
  timeout_ms: 600000,
});

const { source, base_version_id, base_content_hash } = await mcp.call("fetch", {
  workspace_id: workspaceId,
  resource_id: "pg_123",
  include: ["edit_tokens"],
});

await mcp.call("update_page", {
  workspace_id: workspaceId,
  page_id: "pg_123",
  base_version_id,
  base_content_hash,
  find: "old sentence",
  replace: "new sentence",
  expected_replacements: 1,
});

await mcp.call("update_thread", {
  workspace_id: workspaceId,
  thread_id: "thr_42",
  body: "Done — see version " + base_version_id,
  resolve: true,
  agent_name: "Claude",
  agent_model: "opus-4.7",
});
```

## CLI

The CLI is a Rust binary distributed through the `@vegastack/pages` npm package. Two aliases run the same binary:

```sh
npm install -g @vegastack/pages
vpg --help            # short alias
vegastack-pages --help
```

### Shape — noun-first, like `gh` and `wrangler`

Top-level commands cover the hot path and cross-cutting verbs:

```text
vpg login [--token <t>] [--no-browser]
vpg logout
vpg whoami
vpg use <workspace>
vpg search <query> [--type pages|folders|comments|all] [--limit N]
vpg events [--page X] [--workspace W] [--after-id A] [--limit N]
vpg validate [--page <id> | --file <p> | --stdin] [--type markdown|mdx|html]
vpg deploy [--target cloudflare] [--config vegastack-pages.yaml] [--dry-run] [--managed] [--apply-migrations | --skip-migrations]
vpg doctor
vpg update [--check] [--channel latest|next]
vpg completions <bash|zsh|fish|powershell>
```

Noun groups for resource CRUD:

```text
vpg pages       create | get | update | move | restore | versions | wait
vpg comments    list | create | reply | resolve | reopen | delete | complete | move-anchor
vpg publish     page | folder | update | revoke
vpg templates   list | get | create | update | render
vpg workspaces  list | tree | export | members | invite
vpg attachments upload
vpg skills      install | update | print | path | doctor
```

`vpg pages get`, `vpg pages update`, `vpg pages move`, `vpg pages restore`, `vpg pages versions`, `vpg pages wait`, `vpg comments *`, `vpg publish page`, `vpg publish folder`, and `vpg attachments upload` all accept either a `pg_…` id or a slug — the CLI resolves the slug server-side via the page-ref endpoint before issuing the actual API call.

### Global flags

Every command honours these:

| Flag                              | Behavior                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent`                         | Non-interactive mode: JSON envelope to stdout, structured error JSON to stderr, exit codes 1–8, no prompts, no spinners. Streaming commands (`events`, `pages wait`) emit NDJSON. |
| `--json`                          | JSON output, otherwise interactive (confirms etc.).                                                                                                                               |
| `--yes` / `-y`                    | Skip confirmation prompts. Required under `--agent` for destructive ops.                                                                                                          |
| `--workspace W` / `VPG_WORKSPACE` | Override the active workspace.                                                                                                                                                    |
| `--token T` / `VPG_TOKEN`         | Override the stored token.                                                                                                                                                        |
| `--base-url URL` / `VPG_BASE_URL` | Override the API base URL. Stored value is preserved when the flag is omitted.                                                                                                    |
| `--quiet` / `-q`                  | Suppress non-error output.                                                                                                                                                        |
| `--verbose` / `-v`                | Verbose diagnostic logging to stderr.                                                                                                                                             |

### `--agent` output contract

Success (exit 0, stdout):

```json
{ "data": { "...": "..." }, "meta": { "request_id": "...", "duration_ms": 42 } }
```

Error (non-zero exit, stderr):

```json
{
  "error": {
    "code": "VPG_NOT_FOUND",
    "message": "Page pg_x not found.",
    "hint": "Run `vpg pages list` to see available pages.",
    "details": { "...": "..." }
  }
}
```

Streaming (`vpg events`, `vpg pages wait`) — NDJSON, one object per line, stdout:

```text
{"type":"event","event":{ "...": "..." }}
{"type":"event","event":{ "...": "..." }}
{"type":"done","matched":{ "...": "..." }}
```

Exit codes:

| Code | Meaning            |
| ---- | ------------------ |
| 0    | Success            |
| 1    | Generic error      |
| 2    | Validation         |
| 3    | Authentication     |
| 4    | Not found          |
| 5    | Permission denied  |
| 6    | Conflict (version) |
| 7    | Network            |
| 8    | Rate limited       |

### Examples — interactive

```sh
vpg login                                                       # browser device-code flow
vpg use wks_123
vpg pages create --title "Plan" --file ./plan.md
vpg pages create --template prd --title "Search redesign" --set owner=platform
vpg pages get plan-abc123 --include source,edit_tokens
vpg pages update pg_123 --base-version-id ver_42 --find "old" --replace "new" --expected-replacements 1
vpg pages restore pg_123 ver_42                                 # confirms y/N
vpg pages wait pg_123 --until first-response --after-id evt_7
vpg comments list pg_123 --status open
vpg comments reply thr_99 --body "Done." --agent-name Claude --agent-model opus-4.7
vpg comments complete thr_99 --body "Fixed." --resolve --agent-name Claude
vpg publish page pg_123 --permission comment --expires-at 2026-12-31T00:00:00Z
vpg publish revoke pub_42                                       # confirms y/N
vpg templates render prd --title "Search redesign" --set owner=platform
vpg workspaces tree
vpg workspaces invite --email teammate@example.com --role editor
vpg attachments upload pg_123 --filename diagram.png --content-type image/png --base64-file ./diagram.b64
vpg search "runbook" --type pages
vpg events --page pg_123
```

### Examples — `--agent` mode

```sh
vpg --agent whoami
vpg --agent pages get pg_123 --include source,edit_tokens
vpg --agent pages update pg_123 --base-version-id ver_42 --source "# New body"
vpg --agent pages wait pg_123 --until first-response --timeout 600 --poll 2
vpg --agent --yes pages restore pg_123 ver_old                  # --yes required for destructive ops
vpg --agent publish page pg_123 --permission comment
vpg --agent comments reply thr_99 --body "Done." --agent-name Claude
```

`--agent` writes one compact JSON line on success, structured error JSON to stderr on failure. Streaming commands emit one JSON line per event.

### Authentication details

- **Browser device-code (default).** `vpg login` calls `/oauth/device`, prints the verification URL, opens it, and polls `/oauth/token` until the user approves. Uses the baked-in well-known client `oac_vpg_cli`. Sets `kind=oauth` on the session.
- **Manual bearer.** `vpg login --token <tok>` (or `VPG_TOKEN`) stores a workspace-scoped token from **Settings → My Connections**. Sets `kind=cli`.
- **Storage.** Tokens go to the OS keychain when available, otherwise to an owner-only file under `~/.config/vegastack-pages/`. `vpg logout` clears both.

### Build from source

```sh
pnpm --filter @vegastack/pages build
node cli/vegastack-pages/bin/vpg.js --help
# or, from cli/vegastack-pages:
node scripts/build-native.mjs
cargo run --quiet -- --help
```

### Agent skills

`vpg skills install` writes the portable `SKILL.md` bundle to the host agent's skill directory. Adapters cover Claude, Cursor, Codex, and Gemini layouts:

```sh
vpg skills doctor
vpg skills install --agent all --scope user
vpg skills install --agent cursor --scope project
vpg skills update --agent all --scope user
vpg skills path
```

The bundle is embedded into the Rust binary at build time, so installed npm binaries can run `skills install` without a source checkout. MCP clients can read the same content as resources under `vpg://skills/vegastack-pages/…`.

### Deploy helper

`vpg deploy` shells out to the repository's `pnpm deploy:cloudflare`. Run it from a source checkout. See [Self-host on Cloudflare](/docs/cloudflare) for the full install flow.

## Active sessions

Open **Settings → My Connections** to see your own active tokens. Workspace admins can also open **Settings → Connections Log** for the workspace-wide list.

Each row shows the recognized vendor (Claude, ChatGPT, Cursor, Windsurf, Continue, Cline, Codex, vpg CLI, …), kind chip (`oauth | manual | cli`), last-seen timestamp, expiry, and a one-click revoke. Revoked tokens stop working on the next request.

## Related docs

- [Quickstart](/docs/quickstart) — first page, first share, first agent connect
- [Templates](/docs/templates) — typed properties and structured builders
- [Comments and threads](/docs/comments-and-threads) — anchoring and review surface
- [Wait conditions](/docs/wait-conditions) — `wait_for_review` semantics
- [Public links](/docs/public-links) — `apply_publication` for pages and folders
- [Permissions](/docs/permissions) — what each role can do
