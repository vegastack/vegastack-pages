# Local Development Backend

Use the local Node backend for normal feature work. It exercises the same app
routes and persistence services without Cloudflare remote bindings.

## Modes

| Mode                   | Command                             | Storage             | Use case                        |
| ---------------------- | ----------------------------------- | ------------------- | ------------------------------- |
| Local Node             | `pnpm dev -- --port 4322`           | SQLite + filesystem | Default local product testing   |
| Production-data Worker | `pnpm dev:prod-data -- --port 4322` | Remote D1 + R2      | Debugging production state only |

## Fresh Local Instance

```sh
pnpm local:reset
pnpm dev -- --port 4322
pnpm local:setup -- --url http://127.0.0.1:4322
```

After setup, open `http://127.0.0.1:4322/api/auth/dev-login` for the fastest
local sign-in. The setup script also prints an optional magic link for the
seeded admin user.

`pnpm dev` and `pnpm dev:local` set these defaults:

| Setting     | Value                                                 |
| ----------- | ----------------------------------------------------- |
| Runtime     | `VPG_ADAPTER=node`, `VPG_RUNTIME=node`                |
| SQLite      | `.vegastack-pages/local/state/vegastack-pages.sqlite` |
| Objects     | `.vegastack-pages/local/objects`                      |
| Email       | `VPG_EMAIL_PROVIDER=console`                          |
| Setup token | `dev-setup-token`                                     |
| Demo seed   | disabled, so `/setup` is the source of truth          |

## Dev Sign-In

Use direct sign-in for normal local development:

```sh
open http://127.0.0.1:4322/api/auth/dev-login
```

The login page also exposes a dev-only "Skip the email and sign in directly"
action when the server is running in local Node mode.

Magic links are still available for testing the email flow:

```sh
pnpm local:magic-link -- --url http://127.0.0.1:4322 --email dev@example.com
```

In the default local setup, public signup is disabled. A magic link request only
works for a user that already exists in the local database. To test a different
admin email, reset and seed a fresh instance:

```sh
pnpm local:reset
pnpm local:setup -- --url http://127.0.0.1:4322 --email you@example.com
```

## Tunnel Testing

When a Cloudflare Tunnel points at port `4322`, start the server with the tunnel
origin as `VPG_BASE_URL`. If you are not using a tunnel, leave `VPG_BASE_URL`
unset and use the localhost defaults.

```sh
export VPG_PUBLIC_URL=https://<your-tunnel-url>
VPG_BASE_URL="$VPG_PUBLIC_URL" pnpm dev -- --host 0.0.0.0 --port 4322
pnpm local:setup -- --url http://127.0.0.1:4322 --public-url "$VPG_PUBLIC_URL"
```

The app still uses local SQLite and filesystem storage. The public base URL is
only used for generated links and callback URLs.

Open `$VPG_PUBLIC_URL/api/auth/dev-login` for direct dev sign-in through the
tunnel. Use the printed public magic link only when specifically testing email
link behavior.

## Status Check

The dev-only endpoint below verifies that the browser is hitting the safe local
Node backend:

```sh
curl http://127.0.0.1:4322/api/local/status
```

Expected values:

- `adapter`: `node`
- `runtime`: `node`
- `prod_data_dev`: `false`

If `prod_data_dev` is `true`, the server is using production Cloudflare
bindings.
