# CLI Reference

Install `@vegastack/pages` and use either binary alias:

```sh
vpg --help
vegastack-pages --help
```

Auth options:

```sh
vpg login --base-url https://pages.example.com --workspace wks_123 --token "$VPG_TOKEN"
vpg --base-url https://pages.example.com --workspace wks_123 --token "$VPG_TOKEN" whoami
```

Use `--json` for machine-readable output.

The CLI uses standalone VegaStack Pages API routes over HTTP. It does not call MCP, does not require an MCP client, and supports the same page, comment, publication, template, review-wait, workspace tree, attachment, and member workflows exposed through MCP. Pass `--workspace <workspace_id>` or run `vpg use <workspace_id>` before workspace-scoped commands; the CLI sends `workspace_id` on every API call it makes.

## Account And Workspace

```sh
vpg login --token "$VPG_TOKEN" --workspace wks_123
vpg logout
vpg whoami
vpg workspaces
vpg use wks_123
vpg doctor
```

`vpg login` stores the token in the OS keychain where available, otherwise in an owner-only local token file. `vpg use` sets the default workspace.

## Page Editing

```sh
vpg create --file plan.md --title "Plan" --type markdown --folder-path guides
vpg create --stdin --title "Pasted Plan"
vpg create --template tpl_123 --title "Templated Plan" --set owner=platform
vpg pages get pg_123
vpg pages rendered pg_123
vpg pages versions pg_123
vpg pages snapshot pg_123 --label "before review edits"
vpg pages restore-version pg_123 ver_123
vpg pages prepare-edit pg_123
vpg pages validate --page pg_123
vpg pages update-source pg_123 --base-version-id ver_123 --base-content-hash hash_123 --file page.md
vpg pages update-source pg_123 --base-version-id ver_123 --source "# Title" --checkpoint --checkpoint-label "reviewed"
vpg pages patch pg_123 --base-version-id ver_123 --base-content-hash hash_123 --find "old" --replace "new" --expected-replacements 1
vpg pages move pg_123 --title "New title" --folder-path guides/setup
```

## Review

```sh
vpg wait pg_123 --until first-response --timeout-seconds 600
vpg comments pg_123 --status all
vpg comment pg_123 --body "Please clarify this." --selected-text "unclear phrase" --source-start 40 --source-end 54
vpg comment pg_html --body "Move this CTA." --anchor-file html-pin.json
vpg reply cmt_123 --body "Thanks, fixed."
vpg resolve cmt_123
vpg unresolve cmt_123
vpg update-anchor cmt_123 --anchor-file html-pin.json
vpg complete-thread cmt_123 --body "Fixed and verified." --resolve --agent-name Codex
vpg delete-thread cmt_123
vpg events --page pg_123 --limit 50
```

`vpg wait` defaults to 600 seconds and clamps larger values to 600 seconds so review waits do not block an agent indefinitely.

For Markdown/MDX comments, prefer `--selected-text` plus source offsets and prefix/suffix. For HTML pages, use `--anchor-json` or `--anchor-file` with a point selector; see `references/comments.md`.

## Pages, Files, Publishing

```sh
vpg attachments upload pg_123 --filename chart.png --content-type image/png --base64-file chart.b64
vpg attachments upload pg_123 --filename data.json --content-type application/json --base64-body eyJvayI6dHJ1ZX0=
vpg publish-page pg_123 --permission comment
vpg publish-folder fld_123 --permission view
vpg update-publication pub_123 --clear-expires-at --clear-password
vpg revoke-publication pub_123
vpg tree --workspace wks_123
vpg search "deployment"
vpg search "review comment" --type comment
vpg search "guides" --type folder
vpg export wks_123
```

`vpg search` searches pages, folders, and comment threads in the selected workspace. Use `--type page|folder|comment|all` to narrow results. Non-JSON output is a compact table; use global `--json` for the full result contract with snippets, ids, urls, updated timestamps, icons, and matched fields.

## Templates

```sh
vpg templates list
vpg templates show tpl_123
vpg templates render tpl_123 --title "Q3 Plan" --set owner=platform
vpg templates create --args-file template.json
vpg templates update tpl_123 --args-file template-update.json
```

## Members And Admin Helpers

```sh
vpg members invite --email teammate@example.com --display-name "Teammate" --role editor
vpg deploy --target cloudflare --dry-run
vpg update check
vpg update plan
vpg update apply
```

`vpg deploy` is a source-checkout helper for repository maintainers. It shells out to the repository deploy script and must not be used unless the user explicitly asks for deployment. `vpg update` currently reports release-update placeholders; do not rely on it for production self-update behavior.

## Skills

```sh
vpg skills path
vpg skills print
vpg skills doctor
vpg skills install --agent all --scope user
vpg skills update --agent all --scope user
```

The CLI is the global installer for local agent skill files. MCP can expose the same guidance as resources and prompts, but a remote MCP server cannot safely write into every local agent's global config directory.
