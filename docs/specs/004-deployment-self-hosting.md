# Deployment And Self-Hosting Specification

Status: Draft  
Date: 2026-05-10

## Supported Install Modes

Managed:

- VegaStack-hosted app at `pages.vegastack.com/app`.

Primary:

- Cloudflare Workers install.

Secondary:

- Docker/Node install.

Install directories:

```text
install/cloudflare/
install/docker/
```

## Cloudflare Install

Goal: A user with a Cloudflare account and Wrangler auth can deploy VegaStack Pages from a source checkout.

Command:

```sh
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
pnpm deploy:cloudflare -- --apply-migrations --deploy
```

The deploy flow should:

1. Validate local environment.
2. Read `vegastack-pages.yaml`.
3. Validate Cloudflare API token.
4. Create or reuse D1 database.
5. Create or reuse R2 bucket.
6. Generate or update `apps/web/wrangler.jsonc`.
7. Build the Astro SSR Worker.
8. Run D1 migrations when requested.
9. Write the self-host setup token as the `VPG_SETUP_TOKEN` Worker secret.
10. Deploy Worker when requested.
11. Print setup URL without printing secret values.

Self-hosted deployments default to `deployment_mode: self_hosted`, which keeps public signup disabled and uses the setup wizard plus admin invites. Managed deployments use `deployment_mode: managed`, public signup, hosted workspace creation, and the same core workspace/page/comment/MCP APIs.

## Cloudflare API Token Permissions

Docs must list the exact required permissions once implementation chooses final resource APIs.

Expected permission categories:

- Workers scripts edit.
- Workers routes edit if custom domain/route configured.
- D1 edit.
- R2 edit.
- Durable Objects/Workers bindings as required by Wrangler.
- Account read.
- Zone read/edit only if custom domain or DNS setup is automated.

If token permissions are insufficient, the deploy script must fail with a precise missing-permission message.

## Cloudflare Free Support

VegaStack Pages should support small instances on Cloudflare Free where usage fits limits.

Constraints:

- Email sending through Cloudflare Email Service may require Workers Paid, so email is optional.
- Free plan limits should be documented.
- Production docs can recommend Workers Paid for higher limits, predictable production use, and email.

## Hosting Config

File:

```text
vegastack-pages.yaml
```

Purpose:

- Hosting/runtime settings only.
- Workspace settings live in the database and app UI.

Example:

```yaml
app:
  name: vegastack-pages
  base_url: https://pages.example.com

runtime:
  target: cloudflare

cloudflare:
  account_id: ${CLOUDFLARE_ACCOUNT_ID}
  worker_name: vegastack-pages
  d1_database_name: vegastack_pages
  r2_bucket_name: vegastack-pages-content

security:
  setup_token_ttl_minutes: 30
  version_retention_days: 30

auth:
  magic_link: true
  google_oauth:
    enabled: false

email:
  provider: none
```

Secrets must be provided through environment variables or Wrangler secrets, not committed to config.

## Updates

Supported release channels:

- GitHub releases.
- npm package releases.
- Docker images.

CLI support:

```sh
vpg update check
vpg update check --json
pnpm deploy:cloudflare -- --apply-migrations --deploy
```

Later:

```sh
vpg update plan
vpg update apply
```

Update process:

1. Check current app version.
2. Check latest release.
3. Show required migrations.
4. Backup warning if needed.
5. Run migrations.
6. Redeploy Worker or restart Docker service.

## Docker/Node Install

Goal: A user can self-host outside Cloudflare.

Scope:

- Docker image for `apps/web` using Astro Node adapter.
- SQLite database initially.
- Filesystem object storage through a mounted `/data/objects` volume.
- S3-compatible object storage can be added later behind the same provider interface.
- Docker Compose file in `install/docker`.

Example services:

```text
vegastack-pages-web
sqlite volume or external DB
optional S3-compatible storage
```

Node mode must use the same domain services as Cloudflare mode.

## Email

Email is optional for self-hosting. Magic links and invites can be sent through a configured provider, and local/Docker development can keep `VPG_EMAIL_PROVIDER=console`.

Provider interface:

- `none`
- `cloudflare_email_service`
- `ses`

Cloudflare Email Service:

- Worker-native provider through the optional `EMAIL` send binding.
- May require Workers Paid for sending.

SES:

- Implemented through AWS SES HTTPS API signing with runtime secrets:
  `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`.

## Setup Wizard

After first deploy, opening the app shows setup until first admin exists.

Admin creation options:

- Email magic link.
- Setup token supplied by the operator through `VPG_SETUP_TOKEN`.

Setup must seed:

- First workspace.
- Get Started page.
- Agent Review Workflow page.
- MCP Setup page.
- CLI Setup page.
- Default folders.

## Backups And Export

Required:

- Workspace ZIP export of latest source and attachments.
- R2/S3 object paths mirror folders enough to make bucket download understandable.
- Optional GitHub App backup sync for pages, templates, optional assets, and `.vegastack-pages/manifest.json`.
- Deployment-level cron trigger for scheduled GitHub backup sync when configured.

Later:

- External storage replication.
