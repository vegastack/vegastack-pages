---
title: Self-host on Docker
description: Run VegaStack Pages on Docker or Node with SQLite, filesystem object storage, and the same MCP endpoint.
category: Self-host
order: 20
lastUpdated: 2026-05-14
---

Docker runs the same Astro app through the Node adapter. D1 becomes SQLite and R2 becomes filesystem object storage under `/data`.

## What gets swapped

| Cloudflare          | Node / Docker                                         |
| ------------------- | ----------------------------------------------------- |
| Workers + Astro SSR | Node process running the same Astro SSR build         |
| D1                  | SQLite                                                |
| KV sessions         | SQLite-backed app sessions                            |
| R2                  | Local filesystem object storage under `/data/objects` |
| Email Service       | Provider interface, console by default in Compose     |

The renderer, MCP endpoint, comments, permissions, and search use the same application services.

## Quickstart

```sh
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose --file install/docker/docker-compose.yml up --build
```

Open `http://localhost:4321/app/setup` and enter `VPG_SETUP_TOKEN`.

The MCP endpoint is `http://localhost:4321/mcp`.

For a production URL:

```sh
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose --file install/docker/docker-compose.yml up --build -d
```

## Persistence

The Compose file mounts `/data` as a named volume:

- `/data/state/vegastack-pages.sqlite` stores metadata, comments, permissions, sessions, versions, search, and audit logs.
- `/data/objects` stores page source, attachments, exports, and object-backed artifacts.

Back up the SQLite file and object directory together.

## Configuration

Common Docker variables are documented in `install/docker/README.md`. The broader environment model is in `docs/specs/008-configuration-env.md`.
