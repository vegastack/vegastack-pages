# VegaStack Pages

Open-source Agentic Knowledge Base for teams that let agents write and humans review.

Agents use MCP or the `vpg` CLI to create structured Markdown, MDX, and HTML pages. Humans read the rendered page, leave anchored comments, and approve or request edits. Agents then fetch the comments, patch the source with version checks, reply to threads, and keep the page history intact.

VegaStack Pages is built for the whole loop: templates, source editing, review comments, public links, workspace permissions, attachments, search, version history, audit events, and Backup to Git.

## Requirements

- Node.js 24.x recommended. The current Astro/Wrangler dependency set requires modern Node 22+ APIs; CI uses Node 24.
- `pnpm` 10.33.2 through Corepack.
- Rust stable, only when building the CLI locally.
- Docker Compose for the Docker install path.
- A Cloudflare account and Wrangler auth for the Cloudflare install path.

## Product Surface

| Area               | What ships                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent creation     | Remote MCP at `/mcp`, managed MCP at `https://pages.vegastack.com/mcp`, and the Rust-backed `vpg` CLI.                                                                                          |
| Page formats       | Markdown, MDX, and raw HTML. Source stays authoritative.                                                                                                                                        |
| Templates          | Workspace templates with typed properties, reusable sections, and guidance comments for consistent agent output.                                                                                |
| Review             | Rendered pages, anchored inline comments, guest reviewers, agent replies, resolve/unresolve, and wait conditions.                                                                               |
| Editing            | CodeMirror source editor, autosave, manual snapshots, conflict detection, validation, and surgical patch APIs.                                                                                  |
| Sharing            | Page links at `/p/...`, folder links at `/f/...`, View/Comment/Edit permissions, optional expiry, password, and noindex by default.                                                             |
| Organization       | Workspaces, folders, page/folder access rules, favorites, command palette search, and permission-filtered search.                                                                               |
| Attachments        | Page-scoped uploads with permission-checked serving and SVG hardening.                                                                                                                          |
| Templates included | PRD, feature brief, discovery notes, RFC, postmortem, ADR, runbook, launch plan, campaign brief, executive one-pager, meeting notes, weekly update, 1:1 agenda, project kickoff, retrospective. |
| Backup to Git      | Workspace pages, templates, optional assets, and a manifest sync to a GitHub repository through a GitHub App.                                                                                   |
| Auditability       | Audit logs, review events, page versions, template versions, and publication state.                                                                                                             |

## Managed Hosting

Managed hosting runs at:

- App: `https://pages.vegastack.com/app`
- Signup: `https://pages.vegastack.com/app/signup`
- Remote MCP: `https://pages.vegastack.com/mcp`

The managed app and the open-source app are the same codebase. Managed mode enables public signup; self-hosted mode uses first-admin setup.

## Local Development

```sh
corepack enable
pnpm install
pnpm dev -- --port 4322
```

In a second terminal:

```sh
pnpm local:setup -- --url http://127.0.0.1:4322
```

Open `http://127.0.0.1:4322/api/auth/dev-login` for direct local sign-in. The local backend uses SQLite and filesystem object storage under `.vegastack-pages/local`; it does not touch Cloudflare production data.

Verify the backend before writing data:

```sh
curl http://127.0.0.1:4322/api/local/status
```

Expected fields: `runtime=node`, `adapter=node`, `prod_data_dev=false`.

## Self-Host

Cloudflare Workers is the primary deployment target. The source install creates D1, KV, and R2 resources, writes `apps/web/wrangler.jsonc`, applies migrations, and deploys the Worker:

```sh
corepack enable
pnpm install
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
pnpm deploy:cloudflare -- --apply-migrations --deploy
```

Read [install/cloudflare/README.md](install/cloudflare/README.md) before deploying.

Docker/Node runs the same Astro app with SQLite and filesystem object storage:

```sh
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose --file install/docker/docker-compose.yml up --build
```

Read [install/docker/README.md](install/docker/README.md) for persistence and backup notes.

## CLI

The npm package is `@vegastack/pages` and exposes both `vpg` and `vegastack-pages` binaries:

```sh
npm install -g @vegastack/pages
vpg --help
```

Use a workspace-scoped token from **Settings > MCP** or another bearer token accepted by your deployment:

```sh
vpg login --base-url https://pages.vegastack.com --workspace wks_123 --token "$VPG_TOKEN"
vpg create --template prd --title "Search redesign" --set owner=platform
vpg wait pg_123 --until first-response
vpg pages patch pg_123 --base-version-id ver_123 --find "old" --replace "new"
```

For source builds:

```sh
pnpm --filter @vegastack/pages build
node cli/vegastack-pages/bin/vpg.js --help
```

The deploy helper shells out to this repository's `pnpm deploy:cloudflare` script, so run deploy commands from a source checkout. CLI details are in [cli/vegastack-pages/README.md](cli/vegastack-pages/README.md).

## Remote MCP

MCP is the main agent interface.

1. Sign in.
2. Open **Settings > MCP**.
3. Create a workspace-scoped session.
4. Connect an MCP client to `/mcp` on your deployment.

Managed endpoint:

```text
https://pages.vegastack.com/mcp
```

Every tool call includes `workspace_id`. The token is still scoped server-side, but the explicit workspace id prevents accidental cross-workspace calls.

Core tools cover page creation, templates, source reads, validation, patching, attachments, comments, wait conditions, review events, publishing, workspace search, tree reads, page moves, and member invites. See [MCP and CLI docs](apps/web/src/content/docs/mcp-and-cli.md).

## Repository Layout

```text
apps/web              Astro SSR app for Cloudflare Workers and Node
cli/vegastack-pages   Rust CLI package published as @vegastack/pages
packages/config       Config parsing and environment helpers
packages/core         Domain services and policy logic
packages/db           Drizzle schema, migrations, and fixtures
packages/mcp          MCP tool names and schemas
packages/renderer     Markdown/MDX/HTML rendering pipeline
packages/ui           Shared UI tokens and primitives
skills/vegastack-pages Portable agent skill shared by MCP resources and the CLI installer
install/cloudflare    Cloudflare bootstrap and install docs
install/docker        Dockerfile, Compose file, and install docs
docs                  Architecture, specs, ADRs, and local testing notes
```

## Quality Gates

Run these before handing off a code change:

```sh
pnpm typecheck
pnpm test
pnpm format
```

## References

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Support](SUPPORT.md)
- [Local development](docs/local-development.md)
- [Cloudflare install](install/cloudflare/README.md)
- [Docker install](install/docker/README.md)
- [CLI package](cli/vegastack-pages/README.md)
- [MCP local testing](docs/mcp-local-testing.md)
- [Configuration and environment spec](docs/specs/008-configuration-env.md)
- [Project docs index](docs/README.md)
- [Public docs content](apps/web/src/content/docs)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare KV](https://developers.cloudflare.com/kv/)

## Security

Please report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
