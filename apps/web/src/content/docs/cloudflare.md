---
title: Self-host on Cloudflare
description: Deploy VegaStack Pages on Cloudflare Workers with D1, R2, Wrangler, AWS SES or Cloudflare Email Service, and Backup to Git.
category: Self-host
order: 10
lastUpdated: 2026-05-20
---

Cloudflare Workers is the primary deployment target. The source installer creates or reuses D1 and R2 resources, writes `apps/web/wrangler.jsonc`, runs the Astro build, applies migrations, and deploys the Worker.

## Prerequisites

- A Cloudflare account.
- Wrangler login, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Node.js 24.x recommended.
- `pnpm` through Corepack.
- A public HTTPS `VPG_BASE_URL`.
- A `VPG_SETUP_TOKEN` value you keep for first-admin setup.

## Install

```sh
corepack enable
pnpm install
pnpm exec wrangler login
pnpm exec wrangler whoami
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
pnpm deploy:cloudflare -- --apply-migrations --deploy
```

Open `https://pages.example.com/app/setup` and enter `VPG_SETUP_TOKEN`.

The MCP endpoint for agents is `https://pages.example.com/mcp`.

## What the installer does

1. Creates or reuses the D1 database (sessions, pages, comments, audit log).
2. Creates the R2 bucket for source, attachments, versions, and exports.
3. Writes `apps/web/wrangler.jsonc`.
4. Builds the Astro SSR Worker.
5. Applies D1 migrations when `--apply-migrations` is set.
6. Writes `VPG_SETUP_TOKEN` as a Worker secret for self-hosted deployments.
7. Adds the daily GitHub backup cron trigger.
8. Deploys the Worker when `--deploy` is set.

## Optional features

| Feature                  | Configuration                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Email Service | Set `VPG_EMAIL_PROVIDER=cloudflare` or `VPG_ENABLE_CLOUDFLARE_EMAIL=true`, plus `VPG_EMAIL_FROM` and `VPG_EMAIL_FROM_NAME`.                                                               |
| AWS SES                  | Set `VPG_EMAIL_PROVIDER=ses`, `VPG_EMAIL_FROM`, `VPG_EMAIL_FROM_NAME`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. These are written as Worker secrets during deploy. |
| Backup to Git            | Set GitHub App variables: `VPG_GITHUB_APP_ID`, `VPG_GITHUB_APP_SLUG`, `VPG_GITHUB_APP_PRIVATE_KEY`, `VPG_GITHUB_APP_CLIENT_ID`, `VPG_GITHUB_APP_CLIENT_SECRET`.                           |
| Custom domain            | Set `VPG_CUSTOM_DOMAIN=pages.example.com`.                                                                                                                                                |
| Managed mode             | Only for VegaStack-operated hosting. Uses `/app/signup` and public signup.                                                                                                                |

## Build without deploying

```sh
VPG_BASE_URL=https://pages.example.com pnpm deploy:cloudflare
```

This still creates or reuses Cloudflare resources and builds the app, but it does not apply migrations or deploy the Worker.

## Updating

Re-run the deploy command from the updated source checkout:

```sh
VPG_BASE_URL=https://pages.example.com VPG_SETUP_TOKEN="$VPG_SETUP_TOKEN" pnpm deploy:cloudflare -- --apply-migrations --deploy
```

State is preserved unless you explicitly delete the D1 database, R2 bucket, or Worker.

## Reference

The complete install reference, configuration table, and Cloudflare docs links live in `install/cloudflare/README.md`.
