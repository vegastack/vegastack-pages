# `@vegastack/pages`

Rust-backed CLI for VegaStack Pages.

Use it when an agent, shell script, or CI job needs to create pages, render templates, wait for review, patch source, publish links, upload attachments, invite members, or install the portable VegaStack Pages agent skill.

## Binaries

Both aliases run the same binary:

```sh
vpg --help
vegastack-pages --help
```

## Install

```sh
npm install -g @vegastack/pages
vpg --help
```

The package uses platform-specific optional dependencies for the native binary. Supported package targets are currently macOS x64/arm64, Linux x64/arm64, and Windows x64.

Managed hosting:

```sh
vpg login --base-url https://pages.vegastack.com --workspace wks_123 --token "$VPG_TOKEN"
```

Self-hosted:

```sh
vpg login --base-url https://pages.example.com --workspace wks_123 --token "$VPG_TOKEN"
```

## Build From Source

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

## Authentication

The CLI accepts `--token` or `VPG_TOKEN` and sends it as `Authorization: Bearer <token>`.

```sh
vpg login --base-url https://pages.example.com --workspace wks_123 --token "$VPG_TOKEN"
```

`vpg login` stores the token in the OS keychain where available, otherwise in an owner-only local file. Workspace-scoped tokens created in the web app are accepted by the standalone API routes and enforced against their workspace scope.

Get a token from **Settings > Sessions** in the web app, or — for browser-based agents like Claude.ai — let the agent run the OAuth 2.1 + PKCE flow against `/.well-known/oauth-protected-resource`. CLI tokens issued via `vpg login --token` appear on the same Sessions page with `kind=cli` and can be revoked from there.

The CLI talks to standalone VegaStack Pages API routes. It does not call MCP and does not need an MCP client to create/edit pages, handle comments, wait for review, manage templates, update publications, upload attachments, or invite members.

## Common Commands

```sh
vpg whoami
vpg workspaces
vpg --workspace wks_123 create --file ./plan.md --title "Plan"
vpg --workspace wks_123 create --template prd --title "Search redesign" --set owner=platform
vpg --workspace wks_123 templates list
vpg --workspace wks_123 templates render prd --title "Search redesign" --set owner=platform
vpg --workspace wks_123 wait pg_123 --until first-response --after-id evt_42
vpg --workspace wks_123 publish-page pg_123 --permission comment
vpg --workspace wks_123 comments pg_123 --status all
vpg --workspace wks_123 comment pg_123 --body "Clarify this." --selected-text "old phrase"
vpg --workspace wks_123 comment pg_html --body "Move this CTA." --anchor-file html-pin.json
vpg --workspace wks_123 pages prepare-edit pg_123
vpg --workspace wks_123 pages patch pg_123 --base-version-id ver_123 --find old --replace new
vpg --workspace wks_123 pages validate --page pg_123
vpg --workspace wks_123 reply cmt_123 --body "Done."
vpg --workspace wks_123 complete-thread cmt_123 --body "Fixed." --resolve --agent-name Codex
vpg --workspace wks_123 update-anchor cmt_123 --anchor-file html-pin.json
vpg --workspace wks_123 search "runbook" --type page
vpg --workspace wks_123 tree
vpg --workspace wks_123 export
vpg --workspace wks_123 revoke-publication pub_123
vpg --workspace wks_123 templates create --args-file ./template.json
vpg --workspace wks_123 members invite --email teammate@example.com --role editor
```

Notes:

- `vpg wait` emits status `matched` when the condition fires (or `timeout`). Use `--after-id <event_id>` to resume from a known event cursor without re-processing earlier ones.
- `vpg reply` posts as the authenticated user. Use `vpg complete-thread` for agent-attributed replies (sets `agent_name`/`agent_model`/`agent_session_id`) and optionally `--resolve` in the same call.

Template create/update commands accept JSON objects matching the standalone template API. `--set key=value` can patch simple fields, including dotted paths such as `--set properties.owner=platform`.

`pages validate --page <page-id>` validates the stored page source. Add `--source`, `--file`, or `--stdin` to validate unsaved content.

Run `vpg <command> --help` for exact flags.

## Agent Review Loop

The CLI is built around the same loop as MCP:

1. Create a page from a file, stdin, raw source, or a template.
2. Publish a page or folder with View, Comment, or Edit access.
3. Wait for reviewer comments.
4. Prepare an edit to get `base_version_id` and `base_content_hash`.
5. Patch exact text or update source.
6. Reply to or complete comment threads.
7. Keep versions and review events for later audit.

Source types are `markdown`, `mdx`, and `html`.

## Agent Skills

The canonical portable skill lives at the repository root in `skills/vegastack-pages` and is embedded into the Rust binary at build time. Install it explicitly for an agent harness:

```sh
vpg skills doctor
vpg skills install --agent all --scope user
vpg skills update --agent all --scope user
vpg skills install --agent codex --scope project
vpg skills install --agent cursor --scope project
```

Cursor and Gemini receive adapter files because they do not use the same native `SKILL.md` layout. No skill files are installed automatically during npm installation; package-manager install hooks are not a reliable place to ask for confirmation or mutate every agent's global config. After `npm update -g @vegastack/pages`, run `vpg skills update --agent all --scope user` to refresh global skill files from the current binary.

MCP clients can read the same guidance from `vpg://skills/vegastack-pages/...`, but MCP does not install local global skill files. Use `vpg skills install` for that.

## Deploy Command Scope

`vpg deploy` shells out to the repository script `pnpm deploy:cloudflare`. It is a source-checkout helper, not a standalone installer:

```sh
vpg deploy --target cloudflare --apply-migrations
```

Use [install/cloudflare/README.md](../../install/cloudflare/README.md) for the supported Cloudflare install flow.

## Troubleshooting

If the launcher cannot find a native binary in local development, build it first:

```sh
node scripts/build-native.mjs
```
