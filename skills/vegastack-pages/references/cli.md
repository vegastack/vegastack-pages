# CLI Reference

`vpg` is noun-first: `vpg <noun> <verb>`. Top-level slots cover auth and cross-cutting verbs: `login / logout / whoami / use / search / events / validate / deploy / doctor / update / completions`.

Install `@vegastack/pages`. Both aliases work:

```sh
vpg --help
vegastack-pages --help
```

The CLI authenticates to the same REST API as the MCP server. MCP workspace bearer tokens work directly via `--token` or `VPG_TOKEN` (CSRF is bypassed for bearer auth).

## Global flags

| Flag                                  | Effect                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent`                             | Non-interactive. Compact single-line JSON to stdout; structured error JSON to stderr; non-zero exit; no prompts/spinners/pager. Streams = NDJSON. |
| `--json`                              | JSON output but still interactive (prompts allowed).                                                                                              |
| `--yes` / `-y`                        | Skip confirmation. Required under `--agent` for destructive ops (`pages restore`, `publish revoke`, `comments delete`).                           |
| `--workspace W`                       | Override active workspace.                                                                                                                        |
| `--token T` / env `VPG_TOKEN`         | Bearer token. Accepts MCP workspace tokens.                                                                                                       |
| `--base-url URL` / env `VPG_BASE_URL` | API base override. Defaults to stored config, then `https://pages.vegastack.com`.                                                                 |
| `--quiet` / `-q`                      | Suppress interactive chatter. Under `--agent`, the JSON data envelope is still emitted.                                                           |
| `--verbose` / `-v`                    | Diagnostics to stderr.                                                                                                                            |

## `--agent` output contract

Success (stdout, exit 0) — single line, compact:

```json
{
  "data": { "id": "pg_xyz789", "title": "Plan" },
  "meta": { "request_id": "req_abc", "duration_ms": 42 }
}
```

Error (stderr, non-zero exit) — single line, compact:

```json
{
  "error": {
    "code": "VPG_NOT_FOUND",
    "message": "Page pg_x not found.",
    "hint": "Run `vpg pages list` to see available pages.",
    "details": {}
  }
}
```

Exit codes: `0` success, `1` generic, `2` `VPG_VALIDATION`, `3` `VPG_AUTH`, `4` `VPG_NOT_FOUND`, `5` `VPG_PERMISSION`, `6` `VPG_CONFLICT`, `7` `VPG_NETWORK` (5xx), `8` `VPG_RATE_LIMITED`.

Streaming commands (`vpg events`, `vpg pages wait`, `vpg deploy`) emit NDJSON, one object per line:

```
{"type":"event","event":{"id":"evt_1","kind":"comment.created","page_id":"pg_xyz789"}}
{"type":"done","summary":{"count":1,"status":"matched"}}
```

`status` is `"matched"` on success, `"timeout"` on timeout.

## Top-level commands

```sh
vpg login [--token <t>] [--no-browser]
vpg logout
vpg whoami
vpg use <workspace>

vpg search <query> [--type page|folder|comment_thread|comment|all] [--limit N]
vpg events [--page X] [--workspace W] [--after-id A] [--limit N]
vpg validate [--page <id> | --file <p> | --stdin] [--type markdown|mdx|html]
vpg deploy [--target cloudflare] [--config vegastack-pages.yaml] [--dry-run] [--managed] [--apply-migrations | --skip-migrations]
vpg doctor
vpg update [--check] [--channel latest|next]
vpg completions <bash|zsh|fish|powershell>
```

`vpg login` (no `--token`) runs an RFC 8628 device-code flow against `--base-url`, opens the verification URL, and stores the issued workspace token (OS keychain when available, otherwise an owner-only token file). `VPG_NO_OPEN=1` disables the browser launch.

`vpg deploy` is for repository maintainers operating self-hosted Cloudflare Workers — do not run unless asked.

## `vpg pages`

```sh
vpg pages create [--title T] [--file P | --stdin] [--type markdown|mdx|html] [--folder-path P] [--template tpl_X] [--set k=v]...
vpg pages get <page-or-slug> [--include source,rendered,versions,comments,publication,edit_tokens]
vpg pages update <page> --base-version-id ID [--base-content-hash H] \
                        [--file P | --stdin | --source S] \
                        [--find F --replace R [--replace-all] [--expected-replacements N]] \
                        [--checkpoint [--checkpoint-label L]] [--allow-noop]
vpg pages move <page> [--title T] [--folder-path P]
vpg pages restore <page> <version-id>
vpg pages versions <page>
vpg pages wait <page> [--until first-response|new-comment|all-threads-resolved|timeout] [--timeout S] [--poll S] [--after-id A]
```

`vpg pages get` accepts page slugs as well as `pg_…` ids (cycle 5). The slug is resolved server-side.

`vpg pages update` has three modes (mutually exclusive, mirrors MCP):

- **Full replace**: `--file` / `--stdin` / `--source`.
- **Find/replace** (preferred): `--find` + `--replace` with optional `--replace-all` and `--expected-replacements N`.
- **Checkpoint**: `--checkpoint [--checkpoint-label L]` to save a labeled version.

Examples:

```sh
vpg --agent pages create --file plan.md --title "Plan" --type markdown --folder-path guides
vpg --agent pages create --template tpl_review --title "Templated Plan" --set owner=platform
vpg --agent pages get q3-plan --include source,rendered,edit_tokens
vpg --agent pages update pg_xyz789 --base-version-id ver_42 --find "old" --replace "new" --expected-replacements 1
vpg --agent pages update pg_xyz789 --base-version-id ver_42 --file page.md --checkpoint --checkpoint-label "reviewed"
vpg --agent pages restore pg_xyz789 ver_old --yes
vpg --agent pages wait pg_xyz789 --until first-response --timeout 600
```

## `vpg comments`

```sh
vpg comments list <page> [--status open|resolved|all]            # default: open
vpg comments create <page> --body B [--anchor-json J | --anchor-file P | --selected-text S [--source-start N --source-end N]] \
                                    [--anchor-kind text|point] [--surface prose|html] [--confidence active|fuzzy|manual|reanchored|stale]
vpg comments reply <thread> --body B [--agent-name N] [--agent-model M] [--agent-session S]
vpg comments resolve <thread>
vpg comments reopen <thread>
vpg comments delete <thread>
vpg comments complete <thread> --body B [--resolve] [--agent-name N] [--agent-model M] [--agent-session-id S]
vpg comments move-anchor <thread> [--anchor-json J | --anchor-file P | --selected-text S ...]
```

`vpg comments reply` posts as the authenticated user. `vpg comments complete` carries agent attribution and optional `--resolve` in one call.

## `vpg publish`

```sh
vpg publish page   <page>     [--permission view|comment|edit] [--expires-at TS] [--password P] [--indexing-enabled]
vpg publish folder <folder>   [--permission view|comment|edit] [--expires-at TS] [--password P] [--indexing-enabled]
vpg publish update <publication> [--permission ...] [--expires-at TS | --clear-expires-at] [--password P | --clear-password] [--indexing-enabled]
vpg publish revoke <publication>
```

## `vpg templates`

```sh
vpg templates list [--category C]
vpg templates get <template>
vpg templates create [--args J | --args-file P | --set k=v]...
vpg templates update <template> [--args J | --args-file P | --set k=v]...
vpg templates render <template> --title T [--set k=v]...
```

## `vpg workspaces`

```sh
vpg workspaces list
vpg workspaces tree    [--workspace W]
vpg workspaces export  [--workspace W] [--out <path>]
vpg workspaces members
vpg workspaces invite  --email E [--display-name N] [--role reader|commenter|editor|admin] [--workspace W]
```

`vpg workspaces members` calls `GET /api/workspaces/<id>/members` (also reachable via MCP `fetch include: ["members"]`).

## `vpg attachments`

```sh
vpg attachments upload <page> --filename F --content-type CT [--base64-body B64 | --base64-file P]
```

## `vpg skills`

```sh
vpg skills install [--agent all|claude|cursor|gemini] [--scope user|project] [--dir D] [--force] [--dry-run]
vpg skills update  [--agent ...] [--scope ...] [--dry-run]
vpg skills print
vpg skills path
vpg skills doctor
```

The CLI is the global installer for local agent skill files — a Remote MCP server cannot safely write into every local agent's config directory.
