# Docker Install

The Docker install runs the Astro app with the Node adapter, SQLite metadata, and filesystem-backed object storage. It exposes the same app, API routes, and `/mcp` endpoint as the Cloudflare deployment.

## Requirements

- Docker with Compose v2.
- A setup token for the first admin account.

## Quickstart

From the repository root:

```sh
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose --file install/docker/docker-compose.yml up --build
```

Open `http://localhost:4321/app/setup` and enter `VPG_SETUP_TOKEN`.

The local MCP endpoint is:

```text
http://localhost:4321/mcp
```

For a production origin, set `VPG_BASE_URL` before starting:

```sh
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose --file install/docker/docker-compose.yml up --build -d
```

## Runtime

The container uses:

- `VPG_ADAPTER=node`
- `VPG_RUNTIME=node`
- `/data/state/vegastack-pages.sqlite` for metadata, auth, comments, permissions, versions, search, and audit logs.
- `/data/objects` for page source, attachments, exports, and object-backed artifacts.
- `/app/migrations` for startup migrations copied from `packages/db/migrations`.

The Compose file mounts `/data` as a named Docker volume. Back up the SQLite file and object directory together.

## Updating

Rebuild the image and keep the volume:

```sh
docker compose --file install/docker/docker-compose.yml up --build -d
```

Do not delete the Compose volume unless you intend to remove all instance data.

## Configuration

Common environment variables:

| Variable                       | Purpose                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `VPG_BASE_URL`                 | Public origin for generated links and auth callbacks. Defaults to `http://localhost:4321` in Compose. |
| `VPG_SETUP_TOKEN`              | First-admin setup token. Required.                                                                    |
| `VPG_EMAIL_PROVIDER`           | Email provider selector. Defaults to `console` in Compose.                                            |
| `VPG_STATE_DIR`                | Directory for SQLite state. Compose sets `/data/state`.                                               |
| `VPG_SQLITE_PATH`              | SQLite file path. Compose sets `/data/state/vegastack-pages.sqlite`.                                  |
| `VPG_OBJECT_STORE_DIR`         | Filesystem object store directory. Compose sets `/data/objects`.                                      |
| `VPG_GITHUB_APP_ID`            | Optional GitHub App id for Backup to Git.                                                             |
| `VPG_GITHUB_APP_SLUG`          | Optional GitHub App slug for Backup to Git.                                                           |
| `VPG_GITHUB_APP_PRIVATE_KEY`   | Optional GitHub App private key for Backup to Git.                                                    |
| `VPG_GITHUB_APP_CLIENT_ID`     | Optional GitHub App OAuth client id for Backup to Git.                                                |
| `VPG_GITHUB_APP_CLIENT_SECRET` | Optional GitHub App OAuth client secret for Backup to Git.                                            |
| `VPG_GITHUB_SYNC_CRON`         | Optional backup schedule hint. Cloudflare cron uses this directly.                                    |

See [docs/specs/008-configuration-env.md](../../docs/specs/008-configuration-env.md) for the broader config model.
