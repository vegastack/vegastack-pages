# `@vegastack/pages`

Rust-backed CLI for VegaStack Pages. Use it when an agent, shell script, or CI job needs to create pages, render templates, wait for review, edit source, publish links, upload attachments, invite members, or install the portable VegaStack Pages agent skill.

The CLI is noun-first (`vpg <noun> <verb>`) like `gh` and `wrangler`, with a hot-path top level for auth and cross-cutting verbs. Every command honours `--agent` for non-interactive JSON output.

## Install

```sh
npm install -g @vegastack/pages
vpg --help
```

The package uses platform-specific optional dependencies for the native binary. Supported targets are macOS x64/arm64, Linux x64/arm64, and Windows x64. Both `vpg` and `vegastack-pages` run the same binary.

## Authentication

```sh
# Browser device-code (default) — managed hosting:
vpg login

# Self-hosted:
vpg login --base-url https://pages.example.com

# Headless / CI — paste a workspace-scoped token from Settings → My Connections:
vpg login --base-url https://pages.example.com --token "$VPG_TOKEN"

vpg use wks_123
vpg whoami
```

`vpg login` with no `--token` starts the RFC 8628 device-code flow against `/oauth/device` and `/oauth/token`. The CLI prints a verification URL, opens it in the default browser, you pick a workspace and click **Allow**, the CLI receives the access token. Pass `--no-browser` (or set `VPG_NO_OPEN=1`) to skip the auto-launch; the URL still prints — works over SSH. This flow uses the well-known client `oac_vpg_cli` and writes a `kind=oauth` session to **Settings → My Connections**.

`vpg login --token <tok>` (or `VPG_TOKEN`) stores a workspace-scoped token issued from **Settings → My Connections → Create token**. Writes a `kind=cli` session.

Tokens are stored in the OS keychain when available, otherwise in an owner-only file under `~/.config/vegastack-pages/`. Workspace-scoped tokens travel as `Authorization: Bearer <token>` and are enforced server-side against their workspace. Bearer-authenticated requests are exempt from CSRF.

The CLI talks to standalone VegaStack Pages API routes. It does not call MCP and does not need an MCP client.

## Command shape

```text
# Top level — hot path + cross-cutting
vpg login | logout | whoami | use <workspace>
vpg search <query> [--type pages|folders|comments|all] [--limit N]
vpg events [--page X] [--workspace W] [--after-id A] [--limit N]
vpg validate [--page <id> | --file <p> | --stdin] [--type markdown|mdx|html]
vpg deploy [--target cloudflare] [--config vegastack-pages.yaml] [--dry-run] [--managed] [--apply-migrations | --skip-migrations]
vpg doctor
vpg update [--check] [--channel latest|next]
vpg completions <bash|zsh|fish|powershell>

# Noun groups
vpg pages       create | get | update | move | restore | versions | wait
vpg comments    list | create | reply | resolve | reopen | delete | complete | move-anchor
vpg publish     page | folder | update | revoke
vpg templates   list | get | create | update | render
vpg workspaces  list | tree | export | members | invite
vpg attachments upload
vpg skills      install | update | print | path | doctor
```

Run `vpg <command> --help` for exact flags.

## Global flags

Every command honours these:

| Flag                              | Behavior                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--agent`                         | Non-interactive: JSON envelope on stdout, structured error JSON on stderr, no prompts, no spinners.  |
| `--json`                          | JSON output, otherwise interactive.                                                                  |
| `--yes` / `-y`                    | Skip confirmation prompts. Required under `--agent` for destructive ops.                             |
| `--workspace W` / `VPG_WORKSPACE` | Override the active workspace.                                                                       |
| `--token T` / `VPG_TOKEN`         | Override the stored token.                                                                           |
| `--base-url URL` / `VPG_BASE_URL` | Override the API base URL. Stored value is preserved when the flag is omitted (no silent overwrite). |
| `--quiet` / `-q`                  | Suppress non-error output.                                                                           |
| `--verbose` / `-v`                | Verbose diagnostic logging on stderr.                                                                |

Exit codes: `0` ok, `1` generic, `2` validation, `3` auth, `4` not found, `5` permission, `6` conflict (version mismatch), `7` network, `8` rate limited.

## Examples — interactive

```sh
vpg pages create --title "Plan" --file ./plan.md
vpg pages create --template prd --title "Search redesign" --set owner=platform
vpg pages get plan-abc123 --include source,edit_tokens
vpg pages update pg_123 --base-version-id ver_42 --find "old" --replace "new" --expected-replacements 1
vpg pages update pg_123 --base-version-id ver_42 --file ./new-body.md
vpg pages update pg_123 --base-version-id ver_42 --checkpoint --checkpoint-label "before refactor"
vpg pages restore pg_123 ver_old
vpg pages move pg_123 --folder-path /design/2026
vpg pages wait pg_123 --until first-response --after-id evt_42
vpg pages versions pg_123

vpg comments list pg_123 --status open
vpg comments create pg_123 --body "Clarify this." --selected-text "old phrase"
vpg comments create pg_html --body "Move this CTA." --anchor-file html-pin.json --anchor-kind point --surface html
vpg comments reply thr_99 --body "Done." --agent-name Claude --agent-model opus-4.7
vpg comments complete thr_99 --body "Fixed." --resolve --agent-name Claude
vpg comments move-anchor thr_99 --anchor-file html-pin.json --anchor-kind point --surface html
vpg comments resolve thr_99

vpg publish page pg_123 --permission comment --expires-at 2026-12-31T00:00:00Z
vpg publish folder fld_42 --permission view --password "topsecret"
vpg publish update pub_42 --clear-password --indexing-enabled true
vpg publish revoke pub_42

vpg templates list --category product
vpg templates get prd
vpg templates render prd --title "Search redesign" --set owner=platform
vpg templates create --args-file ./template.json
vpg templates update prd --set name="PRD (v2)"

vpg workspaces list
vpg workspaces tree
vpg workspaces members
vpg workspaces invite --email teammate@example.com --role editor
vpg workspaces export --out wks_123.zip

vpg attachments upload pg_123 --filename diagram.png --content-type image/png --base64-file ./diagram.b64

vpg search "runbook" --type pages
vpg events --page pg_123
```

### Slug resolution

Page commands (`vpg pages get`, `update`, `move`, `restore`, `versions`, `wait`; `vpg comments *`; `vpg publish page`; `vpg attachments upload`) accept either a `pg_…` id or a slug — the CLI resolves the slug server-side via the page-ref endpoint before issuing the actual API call.

### `vpg pages update` — three modes

| Mode            | Required                                         | Optional                                                                                                |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Full source     | `--source`, `--file`, or `--stdin`               | `--checkpoint`, `--checkpoint-label`, `--allow-noop`, `--base-content-hash`                             |
| Find / replace  | `--find` (with optional `--replace`)             | `--replace-all`, `--expected-replacements`, `--checkpoint`, `--checkpoint-label`, `--base-content-hash` |
| Checkpoint only | `--checkpoint` (and **no** source/find provided) | `--checkpoint-label`                                                                                    |

All three require `--base-version-id`. Fields not relevant to the chosen mode are omitted from the request body (not sent as `null`) so strict server validators accept the call.

Fetch a current `base_version_id` + `base_content_hash` with:

```sh
vpg pages get pg_123 --include edit_tokens
```

## Examples — `--agent` mode

`--agent` writes one compact JSON line on success, structured JSON error to stderr on failure, NDJSON for streaming commands.

```sh
vpg --agent whoami
vpg --agent workspaces list
vpg --agent pages get pg_123 --include source,edit_tokens
vpg --agent pages update pg_123 --base-version-id ver_42 --find "old" --replace "new"
vpg --agent pages wait pg_123 --until first-response --timeout 600 --poll 2
vpg --agent --yes pages restore pg_123 ver_old             # --yes required for destructive ops
vpg --agent publish page pg_123 --permission comment
vpg --agent comments reply thr_99 --body "Done." --agent-name Claude
```

Success envelope (stdout, exit 0):

```json
{
  "data": { "id": "pg_123", "title": "Plan", "version_id": "ver_42" },
  "meta": { "request_id": "req_…", "duration_ms": 41 }
}
```

Error envelope (stderr, non-zero exit):

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

Streaming (NDJSON, stdout):

```text
{"type":"event","event":{"id":"evt_1","kind":"comment_created", "...": "..."}}
{"type":"event","event":{"id":"evt_2","kind":"thread_resolved", "...": "..."}}
{"type":"done","matched":{ "...": "..."}}
```

## Agent review loop

```sh
# 1. Create
vpg pages create --template prd --title "Plan" --set owner=platform

# 2. Publish for review
vpg publish page pg_123 --permission comment

# 3. Wait
vpg pages wait pg_123 --until first-response --timeout 600

# 4. Refresh edit tokens + read comments
vpg pages get pg_123 --include source,edit_tokens,comments

# 5. Patch
vpg pages update pg_123 --base-version-id ver_42 --find "old" --replace "new"

# 6. Reply / resolve
vpg comments complete thr_99 --body "Fixed." --resolve --agent-name Claude
```

Source types are `markdown`, `mdx`, and `html`.

## Agent skills

The canonical portable skill lives at the repository root in `skills/vegastack-pages` and is embedded into the Rust binary at build time. Install it explicitly for an agent harness:

```sh
vpg skills doctor
vpg skills install --agent all --scope user
vpg skills update --agent all --scope user
vpg skills install --agent cursor --scope project
vpg skills path
vpg skills print
```

Cursor and Gemini receive adapter files because they do not use the same native `SKILL.md` layout. No skill files are installed automatically during npm installation; package-manager install hooks are not a reliable place to ask for confirmation. After `npm update -g @vegastack/pages`, run `vpg skills update --agent all --scope user` to refresh global skill files from the current binary.

MCP clients can read the same guidance from `vpg://skills/vegastack-pages/...`, but MCP does not install local global skill files. Use `vpg skills install` for that.

## Deploy command scope

`vpg deploy` shells out to the repository script `pnpm deploy:cloudflare`. It is a source-checkout helper, not a standalone installer:

```sh
vpg deploy --target cloudflare --apply-migrations
```

See [install/cloudflare/README.md](../../install/cloudflare/README.md) for the supported Cloudflare install flow.

## Build from source

From the repository root:

```sh
pnpm --filter @vegastack/pages build
node cli/vegastack-pages/bin/vpg.js --help
```

Or from this directory:

```sh
node scripts/build-native.mjs
node bin/vpg.js --help
cargo run --quiet -- --help
```

## Troubleshooting

If the launcher cannot find a native binary in local development, build it first:

```sh
node scripts/build-native.mjs
```

Run `vpg doctor` to verify keychain, network reachability, and stored config.
