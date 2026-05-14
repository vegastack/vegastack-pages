# Configuration And Environment Specification

Status: Draft  
Date: 2026-05-14

## Config Philosophy

`vegastack-pages.yaml` stores hosting/runtime settings. Workspace settings live in the database and are edited in the app UI.

Secrets must not be committed to config. Use environment variables, Wrangler secrets, Docker secrets, or platform secret stores.

## Config File

Default file:

```text
vegastack-pages.yaml
```

Example:

```yaml
app:
  name: vegastack-pages
  base_url: https://pages.example.com
  deployment_mode: self_hosted
  public_url_mode: clean
  home_mode: landing # landing | redirect_to_app | redirect_to_first_page

runtime:
  target: cloudflare
  environment: production

cloudflare:
  account_id: ${CLOUDFLARE_ACCOUNT_ID}
  worker_name: vegastack-pages
  compatibility_date: "2026-05-10"
  d1_database_name: vegastack_pages
  r2_bucket_name: vegastack-pages-content
  durable_object_namespace: VEGASTACK_PAGES_EVENTS

node:
  database_url: ${DATABASE_URL}
  object_store:
    provider: s3
    endpoint: ${S3_ENDPOINT}
    bucket: ${S3_BUCKET}
    region: ${S3_REGION}

security:
  setup_token_ttl_minutes: 30
  version_retention_days: 30
  session_ttl_days: 30
  public_link_password_min_length: 8

auth:
  public_signup:
    enabled: false
    create_workspace_on_signup: true
  magic_link:
    enabled: true
  google_oauth:
    enabled: false

email:
  provider: none

limits:
  max_attachment_bytes: 10485760
  max_page_source_bytes: 1048576
  max_public_comment_body_bytes: 10000
```

## Required Environment Variables

Cloudflare deploy:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Runtime secrets:

- `VPG_SETUP_TOKEN` for self-hosted first-run setup.

Deployment mode:

- `VPG_DEPLOYMENT_MODE=self_hosted` keeps public signup disabled unless explicitly configured.
- `VPG_DEPLOYMENT_MODE=managed` enables the managed-hosting path at `pages.vegastack.com/app`.
- `VPG_PUBLIC_SIGNUP=true` can be used in development or a controlled self-hosted deployment to test public signup.
- `VPG_HOME_MODE=landing` keeps `/` as the public homepage and `/app` as the app entry. Use `redirect_to_app` or `redirect_to_first_page` for private self-hosted instances that should skip the homepage.

Optional Google OAuth:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Optional S3-compatible Node mode:

- `VPG_SQLITE_PATH`: SQLite database path for Node/Docker metadata, defaulting under `VPG_STATE_DIR`.
- `VPG_DB_MIGRATIONS_DIR`: directory containing SQL migrations for Node/Docker startup.
- `VPG_OBJECT_STORE_DIR`: filesystem object-store directory for page source, versions, attachments, and exports.

Optional email:

- `VPG_EMAIL_PROVIDER`: `console`, `cloudflare`, `cloudflare_email_service`, `ses`, or `auto`.
- `VPG_ENABLE_CLOUDFLARE_EMAIL=true`: include the Cloudflare Email Service binding.
- `VPG_EMAIL_FROM`: sender address for Cloudflare Email Service or AWS SES. Required when a sending provider is enabled.
- `VPG_EMAIL_FROM_NAME`: sender display name.
- `AWS_REGION`: AWS SES region for `VPG_EMAIL_PROVIDER=ses`.
- `AWS_ACCESS_KEY_ID`: AWS SES access key id, stored as a Worker secret.
- `AWS_SECRET_ACCESS_KEY`: AWS SES secret access key, stored as a Worker secret.
- `AWS_SESSION_TOKEN`: optional AWS session token, stored as a Worker secret when set.

Optional GitHub backup:

- `VPG_GITHUB_APP_ID`: GitHub App id.
- `VPG_GITHUB_APP_SLUG`: GitHub App slug used for the install flow.
- `VPG_GITHUB_APP_PRIVATE_KEY`: GitHub App private key, stored as a runtime secret.
- `VPG_GITHUB_APP_CLIENT_ID`: GitHub App OAuth client id used to verify the installing GitHub user.
- `VPG_GITHUB_APP_CLIENT_SECRET`: GitHub App OAuth client secret, stored as a runtime secret.
- `VPG_GITHUB_SYNC_CRON`: deployment-level UTC cron, default `17 2 * * *`.

MCP authorization:

- `VPG_MCP_TOKEN`: optional static debug bearer. Disabled in production unless `VPG_ALLOW_STATIC_MCP_TOKEN=true`. Pair with `VPG_MCP_WORKSPACE_ID` to bind the static token to a workspace and optionally `VPG_MCP_STATIC_USER_EMAIL` to bind it to a user.
- `VPG_ALLOW_STATIC_MCP_TOKEN`: must be `true` for `VPG_MCP_TOKEN` to be honored in production.
- `VPG_MCP_STATIC_USER_EMAIL`: maps `VPG_MCP_TOKEN` to a user record.
- `VPG_MCP_WORKSPACE_ID`: workspace bound to `VPG_MCP_TOKEN` (required when the static token is enabled).
- `VPG_MCP_AUTH_REQUIRED`: force MCP bearer auth even when `devAutoLogin` is enabled.
- `VPG_MCP_ALLOWED_HOSTS`: comma-separated Host-header allowlist for the `/mcp` DNS-rebinding guard. The request URL host and loopback addresses are always allowed; use this for reverse-proxy or split-DNS deployments that present a different Host.
- `VPG_MCP_ALLOWED_ORIGINS`: **deprecated, no-op.** Bearer-only auth on `/mcp` removes the CSRF surface, so origin validation has been replaced by Host-header validation. The variable is read once at startup and logged as deprecated.
- `VPG_MCP_MAX_BODY_BYTES`: maximum JSON-RPC body size for MCP requests; protects against large-attachment uploads exceeding the chosen budget.

## Cloudflare Bindings

Expected binding names:

- `DB`: D1 database.
- `CONTENT`: R2 bucket.
- `SESSION`: KV namespace for session storage.
- `ASSETS`: Workers static assets binding generated by Astro/Cloudflare.
- `EMAIL`: optional Cloudflare Email Service binding for magic links and invites.
- AWS SES uses runtime secrets instead of a Cloudflare binding.

The Worker also defines a deployment-level cron trigger for GitHub backup sync
when GitHub backup is configured. Workspace-level backup settings stay in D1.

The exact `wrangler.jsonc` must be generated by the deploy command to avoid users hand-editing low-level bindings.

Illustrative shape:

```jsonc
{
  "name": "vegastack-pages",
  "main": "dist/_worker.js/index.js",
  "compatibility_date": "2026-05-10",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": {
    "binding": "ASSETS",
    "directory": "./dist/client",
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "vegastack_pages",
      "database_id": "<generated>",
    },
  ],
  "r2_buckets": [
    {
      "binding": "CONTENT",
      "bucket_name": "vegastack-pages-content",
    },
  ],
  "kv_namespaces": [
    {
      "binding": "SESSION",
      "id": "<generated>",
    },
  ],
}
```

## Astro Config Expectations

Implementation must verify against local Astro 6.3 docs before coding.

Expected:

- `output: "server"` for the app.
- `@astrojs/cloudflare` for Cloudflare target.
- `@astrojs/node` for Node/Docker target.
- `@astrojs/mdx` only where static/built-in MDX needs Astro compilation.
- React integration for islands.
- Tailwind v4 integration through Vite.

Avoid hard-coding Cloudflare-only APIs in business services.

## Drizzle And Migrations

Package:

```text
packages/db
```

Responsibilities:

- Schema definitions.
- Migrations.
- Seed data.
- Test fixtures.
- D1 and SQLite adapters.

Migration rules:

- Migrations are append-only.
- Every migration has a test.
- Setup flow runs migrations before app setup.
- Deploy command checks migration status before deploy completion.

## Config Validation

`packages/config` must expose:

- Schema parser.
- Environment variable resolver.
- Redacted config printer.
- Runtime target validator.
- Deploy target validator.

Invalid config must fail early with actionable messages.

## Workspace Settings In Database

Workspace settings stored in DB:

- Workspace display name and slug.
- Default page visibility.
- Default version retention override.
- Member roles.
- Folder/page permissions.
- Share defaults.
- Search indexing preference.
- Template rows and versions.
- GitHub backup connection and latest sync runs.
- Seed page completion state.

Do not store workspace settings in `vegastack-pages.yaml`.

## Local Development Defaults

Development should support:

- Local D1/SQLite.
- Local R2 emulation or filesystem object store.
- Seed workspace.
- Setup bypass only in test mode.

No production build should enable setup bypass.
