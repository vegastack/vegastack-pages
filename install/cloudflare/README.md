# Cloudflare Install

This path deploys `apps/web` to Cloudflare Workers with D1, KV, R2, Workers Assets, a cron trigger for Backup to Git, and optional email through Cloudflare Email Service or AWS SES.

## Requirements

- Node.js 24.x recommended.
- `pnpm` through Corepack.
- A Cloudflare account.
- Wrangler auth via `pnpm exec wrangler login`, or `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`.
- A public HTTPS base URL for the deployed app.
- A setup token you control for the first admin account.

## Authentication

For an interactive local deploy:

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
```

For non-interactive deploys, set:

```sh
export CLOUDFLARE_ACCOUNT_ID=<account-id>
export CLOUDFLARE_API_TOKEN=<token>
```

The token must be able to run the Wrangler operations used by `install/cloudflare/bootstrap.mjs`: `whoami`, D1 list/create/migrations, KV namespace list/create, R2 bucket create, Worker secret writes, and Worker deploy. Custom-domain installs also need permission to create the Worker route.

## Deploy

From the repository root:

```sh
corepack enable
pnpm install
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
pnpm deploy:cloudflare -- --apply-migrations --deploy
```

Open `https://pages.example.com/app/setup` and enter the same `VPG_SETUP_TOKEN` value.

After setup, the MCP endpoint is available at:

```text
https://pages.example.com/mcp
```

If you forget to set `VPG_SETUP_TOKEN`, the bootstrap script generates one and writes it as a Worker secret without printing it. Set a known value and redeploy, or rotate it from `apps/web`:

```sh
cd apps/web
pnpm exec wrangler secret put VPG_SETUP_TOKEN
```

## Build Without Deploying

This creates or reuses the Cloudflare resources, writes `apps/web/wrangler.jsonc`, and builds the app. It does not deploy the Worker and does not apply migrations:

```sh
VPG_BASE_URL=https://pages.example.com pnpm deploy:cloudflare
```

Apply migrations without deploying:

```sh
VPG_BASE_URL=https://pages.example.com pnpm deploy:cloudflare -- --apply-migrations
```

## Configuration

Environment variables override `vegastack-pages.yaml`.

| Variable                       | Default                     | Purpose                                                                                         |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `VPG_BASE_URL`                 | `https://pages.example.com` | Public origin for links and auth callbacks.                                                     |
| `VPG_SETUP_TOKEN`              | generated if unset          | First-admin setup token for self-hosted deployments. Set it yourself before deploy.             |
| `VPG_WORKER_NAME`              | `vegastack-pages`           | Worker name.                                                                                    |
| `VPG_CUSTOM_DOMAIN`            | empty for self-hosted       | Custom-domain route pattern.                                                                    |
| `VPG_HOME_MODE`                | `landing`                   | Use `redirect_to_app` or `redirect_to_first_page` for private installs.                         |
| `VPG_DEPLOYMENT_MODE`          | `self_hosted`               | Set `managed` only for the VegaStack-operated managed app.                                      |
| `VPG_D1_DATABASE_NAME`         | `vegastack_pages`           | D1 database name.                                                                               |
| `VPG_D1_DATABASE_ID`           | empty                       | Reuse an existing D1 database.                                                                  |
| `VPG_KV_NAMESPACE_NAME`        | `<worker-name>-sessions`    | KV namespace name for sessions.                                                                 |
| `VPG_KV_NAMESPACE_ID`          | empty                       | Reuse an existing KV namespace.                                                                 |
| `VPG_R2_BUCKET_NAME`           | `vegastack-pages-content`   | R2 bucket for page source, attachments, versions, and exports.                                  |
| `VPG_EMAIL_PROVIDER`           | `auto`                      | Email provider selector: `auto`, `console`, `cloudflare`, `cloudflare_email_service`, or `ses`. |
| `VPG_ENABLE_CLOUDFLARE_EMAIL`  | `false`                     | Add the `EMAIL` send binding when `true`.                                                       |
| `VPG_EMAIL_FROM`               | empty                       | Sender address for Cloudflare Email Service or AWS SES. Required when sending email.            |
| `VPG_EMAIL_FROM_NAME`          | `VegaStack Pages`           | Sender display name. Required by the bootstrap script for AWS SES deploys.                      |
| `AWS_REGION`                   | empty                       | AWS SES region. Required for `VPG_EMAIL_PROVIDER=ses`.                                          |
| `AWS_ACCESS_KEY_ID`            | empty                       | AWS SES access key id. Written as a Worker secret for `ses` deploys.                            |
| `AWS_SECRET_ACCESS_KEY`        | empty                       | AWS SES secret access key. Written as a Worker secret for `ses` deploys.                        |
| `AWS_SESSION_TOKEN`            | empty                       | Optional AWS session token. Written as a Worker secret when set.                                |
| `VPG_GITHUB_APP_ID`            | empty                       | GitHub App id for workspace backup sync.                                                        |
| `VPG_GITHUB_APP_SLUG`          | empty                       | GitHub App slug used for the install redirect.                                                  |
| `VPG_GITHUB_APP_PRIVATE_KEY`   | empty                       | GitHub App private key. Written as a Worker secret when set during deploy.                      |
| `VPG_GITHUB_APP_CLIENT_ID`     | empty                       | GitHub App OAuth client id for verifying installations.                                         |
| `VPG_GITHUB_APP_CLIENT_SECRET` | empty                       | GitHub App OAuth client secret for verifying installations.                                     |
| `VPG_GITHUB_SYNC_CRON`         | `17 2 * * *`                | UTC cron trigger for daily GitHub backup sync.                                                  |

## Resources

The generated `apps/web/wrangler.jsonc` binds:

- Worker script for `apps/web`.
- Workers Assets as `ASSETS`.
- D1 database as `DB`.
- KV namespace as `SESSION`.
- R2 bucket as `CONTENT`.
- Cron trigger for GitHub backup sync.
- Optional Cloudflare Email Service binding as `EMAIL`.
- Optional AWS SES runtime secrets for `VPG_EMAIL_PROVIDER=ses`.

Do not hand-edit low-level binding names unless the application code changes with them.

## Backup to Git

Backup to Git is optional. Configure a GitHub App and set the GitHub variables above before deploy. Workspace admins can then connect a repository from **Settings > General**, choose a branch and root path, include or exclude assets, and run a manual sync.

The sync writes:

- Page source files.
- Workspace templates.
- Optional page assets under the configured root.
- `.vegastack-pages/manifest.json`, used to track files owned by the backup job.

The scheduled sync uses `VPG_GITHUB_SYNC_CRON`. Manual sync uses the same code path.

## Managed Mode

Managed mode is only for the VegaStack-operated app:

```sh
VPG_BASE_URL=https://pages.vegastack.com pnpm deploy:cloudflare -- --managed --apply-migrations --deploy
```

Self-hosted deployments keep public signup disabled and use `/app/setup`. Managed deployments enable `/app/signup`.

Managed hosting MCP runs at `https://pages.vegastack.com/mcp`.

## Production-Data Debugging

Local debugging against remote Cloudflare bindings is an explicit opt-in:

```sh
pnpm dev:prod-data -- --port 4322
```

This marks D1, R2, and KV bindings as `remote: true`. Any local write changes the configured Cloudflare data. Use the normal `pnpm dev` local Node backend for feature work.

## References

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1](https://developers.cloudflare.com/d1/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [KV](https://developers.cloudflare.com/kv/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
