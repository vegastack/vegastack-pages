# Security and reliability

## Tokens

- Treat MCP/CLI tokens as secrets. Never write them into pages, templates, skills, logs, or generated files.
- Tokens are workspace-scoped. Browser MCP clients get one via OAuth 2.1 + PKCE (~1 h access token, 60 d refresh). Manual tokens (Settings → My Connections) and `vpg login` tokens default to 30 days.
- An MCP workspace bearer token is also accepted by the REST API the CLI uses — set `VPG_TOKEN` or `--token` to share auth across surfaces. Bearer auth is exempt from CSRF.
- Workspace admins see all members' tokens at Settings → Connections Log and can revoke them there.

## Concurrency

- Always fetch `edit_tokens` before mutating page source: MCP `fetch include: ["edit_tokens"]`, CLI `vpg pages get <page> --include edit_tokens`.
- Always pass `base_version_id` to `update_page` / `vpg pages update`. Pass `base_content_hash` when available — it catches whitespace-only drift.
- Use `expected_replacements` / `--expected-replacements N` on find/replace patches so a runaway match fails loudly.
- On `VPG_CONFLICT` (HTTP 409, CLI exit 6) refetch and recompute. Do not bypass concurrency.
- Validate substantial edits with `validate_page_source` / `vpg validate` first — Mermaid 11 traps are the most common silent break.

## Public publications

`apply_publication.permission` controls what the public link can do:

- `view` — read-only.
- `comment` — read + comment threads (most common review setting).
- `edit` — public visitors can edit. Treat as dangerous; require explicit user confirmation.

`apply_publication` rejects mismatched `publication_id` + `resource_id`. `password` and `expires_at` are clearable via `clear_password: true` and `clear_expires_at: true` on update.

## Mutations that combine surfaces

Prefer MCP when connected; prefer CLI for shell/CI. Do not run both for the same mutation concurrently — they share concurrency tokens, so the second writer will hit `VPG_CONFLICT`.

## Comment attribution

- `update_thread` / `vpg comments reply` posts as the authenticated user.
- For agent-attributed completion replies, pass `agent_name`, `agent_model`, `agent_session_id` to `update_thread` (MCP) or use `vpg comments complete <thr> --resolve --agent-name <n> --agent-model <m> --agent-session-id <s>`.
- `delete_thread` is admin-only and emits a `comment.deleted` review event.

## Destructive ops under `--agent`

`pages restore`, `publish revoke`, `comments delete` require explicit `--yes` under `--agent`. Without it, the CLI exits 2 (`VPG_VALIDATION`).

## Members enumeration

`GET /api/workspaces/<id>/members` returns the roster (`vpg workspaces members`). Same data is reachable via MCP `fetch resource_id: "wks_…" include: ["members"]`.

## Skill installation

Do not install skills automatically from package scripts. Use explicit `vpg skills install --agent all --scope user`. The CLI never overwrites user files unless `--force` is set. After CLI upgrades, refresh global skills with `vpg skills update --agent all --scope user` — this overwrites only the VegaStack Pages skill/adapters managed by the current binary.

## Logging hygiene

Never echo magic-link URLs, invite tokens, OAuth codes, or password values into chat or logs.
