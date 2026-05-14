# Contributing

Use the local Node backend for normal development. It is persistent, fast, and does not touch Cloudflare D1, R2, KV, or production data.

## Requirements

- Node.js 24.x recommended; CI uses Node 24.
- `pnpm` 10.33.2 through Corepack.
- Rust stable only when changing `cli/vegastack-pages`.

## First Run

```sh
corepack enable
pnpm install
pnpm dev -- --port 4322
```

In a second terminal:

```sh
pnpm local:setup -- --url http://127.0.0.1:4322
```

Open `http://127.0.0.1:4322/api/auth/dev-login`, or use the dev-only direct sign-in action on the login page. The printed magic link is optional and mainly useful when testing email flow for the seeded admin account.

## Tunnel Or Preview URL

If a tunnel points at the dev server, set the public URL in both the server and setup commands. Do not set `VPG_BASE_URL` when you are only using localhost.

Terminal 1:

```sh
export VPG_PUBLIC_URL=https://<your-tunnel-url>
VPG_BASE_URL="$VPG_PUBLIC_URL" pnpm dev -- --host 0.0.0.0 --port 4322
```

Terminal 2:

```sh
pnpm local:setup -- --url http://127.0.0.1:4322 --public-url "$VPG_PUBLIC_URL"
```

Open `$VPG_PUBLIC_URL/api/auth/dev-login`. The printed public magic link should only be used when testing email delivery.

Local magic links only work for users already present in the local database when public signup is disabled. To use a different dev email, reset and seed a fresh local instance:

```sh
pnpm local:reset
pnpm local:setup -- --url http://127.0.0.1:4322 --email you@example.com
```

## Useful Commands

```sh
pnpm local:reset
pnpm local:setup -- --url http://127.0.0.1:4322 --email dev@example.com
pnpm local:magic-link -- --url http://127.0.0.1:4322 --email dev@example.com
curl -L http://127.0.0.1:4322/api/auth/dev-login
curl http://127.0.0.1:4322/api/local/status
```

Expected local status:

```json
{ "runtime": "node", "adapter": "node", "prod_data_dev": false }
```

## Verification

Run before handing off a change:

```sh
pnpm typecheck
pnpm test
pnpm format
```

When changing the CLI, also verify the command surface:

```sh
cd cli/vegastack-pages
cargo run --quiet -- --help
cargo run --quiet -- create --help
cargo run --quiet -- deploy --help
```

## Docs Accuracy

Update user-facing docs in the same change when you change commands, environment variables, install paths, auth behavior, ports, or storage locations. The main public surfaces are:

- [README.md](README.md)
- [install/cloudflare/README.md](install/cloudflare/README.md)
- [install/docker/README.md](install/docker/README.md)
- [cli/vegastack-pages/README.md](cli/vegastack-pages/README.md)
- [apps/web/src/content/docs](apps/web/src/content/docs)

## Production Data

Do not use `pnpm dev:prod-data` for normal work. It runs the local Worker with remote Cloudflare bindings and writes to production data. Use it only when the maintainer explicitly asks you to debug production state.
