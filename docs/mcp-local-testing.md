# MCP Local Testing

VegaStack Pages exposes MCP at `/mcp` on the web app. In local development the demo workspace is `wks_demo`.

Managed hosting exposes the same endpoint at:

```text
https://pages.vegastack.com/mcp
```

## Run

```sh
pnpm dev -- --host 127.0.0.1 --port 4322
```

Endpoint:

```text
http://127.0.0.1:4322/mcp
```

For a tunnel mapped to port 4322, use the tunnel URL instead.

## Claude Code

```sh
claude mcp add --transport http --scope local vegastack-pages http://127.0.0.1:4322/mcp
```

With a tunnel:

```sh
claude mcp add --transport http --scope local vegastack-pages https://pages-mk.vegastack.dev/mcp
```

## Codex

```sh
codex mcp add vegastack-pages --url http://127.0.0.1:4322/mcp
```

With a tunnel:

```sh
codex mcp add vegastack-pages --url https://pages-mk.vegastack.dev/mcp
```

## Dev Auth

For normal local development, use the seeded dev user and the local app. For tunnel testing, set `VPG_MCP_TOKEN` to require bearer auth:

```sh
VPG_MCP_TOKEN=dev-secret pnpm dev -- --host 127.0.0.1 --port 4322
```

Production deployments should issue tokens through one of:

- OAuth 2.1 + PKCE from a browser MCP client (Claude.ai, ChatGPT, Cursor remote, …). The client auto-discovers `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` and registers itself; no setup required.
- Manual bearer from **Settings → My Connections** in the web app.
- `vpg login --token <token>` for headless CLI use.

Static MCP tokens (`VPG_MCP_TOKEN`) are a local/debug path and require `VPG_ALLOW_STATIC_MCP_TOKEN=true` plus `VPG_MCP_WORKSPACE_ID` outside dev.

Claude Code:

```sh
claude mcp add --transport http --scope local vegastack-pages https://pages-mk.vegastack.dev/mcp \
  --header "Authorization: Bearer dev-secret"
```

Codex:

```sh
export VPG_MCP_TOKEN=dev-secret
codex mcp add vegastack-pages --url https://pages-mk.vegastack.dev/mcp --bearer-token-env-var VPG_MCP_TOKEN
```

## Large Payloads

For curl, write the JSON-RPC payload to a file and use `--data-binary`:

```sh
curl -s http://127.0.0.1:4322/mcp \
  -H 'content-type: application/json' \
  --data-binary @payload.json
```

The server enforces `VPG_MCP_MAX_BODY_BYTES`, defaulting to 2 MiB.

Browser connector refresh probes can also open the endpoint as an SSE stream:

```sh
curl -i -N http://127.0.0.1:4322/mcp
```

Expected: `200 OK` with `content-type: text/event-stream`.

## Host Validation

`/mcp` validates the Host header per MCP 2025-11-25 to prevent DNS-rebinding attacks. When running behind a reverse proxy, set `VPG_MCP_ALLOWED_HOSTS` to the public host(s) you'll present:

```sh
export VPG_MCP_ALLOWED_HOSTS=pages.example.com,pages-staging.example.com
```

Loopback hosts (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) and any host that matches the request URL are always allowed. The legacy `VPG_MCP_ALLOWED_ORIGINS` is a no-op (Bearer-only auth removes the CSRF surface).

## OAuth Endpoints

Verify the full OAuth surface is reachable in dev:

```sh
curl -s http://127.0.0.1:4322/.well-known/oauth-protected-resource | jq
curl -s http://127.0.0.1:4322/.well-known/oauth-authorization-server | jq
```

For a quick end-to-end probe of the 401 contract (should include `resource_metadata` and `error="invalid_token"`):

```sh
curl -i -X POST http://127.0.0.1:4322/mcp \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

## Agent Edit Flow

Use this sequence for reliable edits against the consolidated MCP surface:

1. `fetch` with `resource_id: "pg_…"` and `include: ["source", "edit_tokens"]` — one call returns the live source, `base_version_id`, and `base_content_hash`.
2. Modify the returned `source`.
3. `update_page` — three mutually-exclusive modes:
   - Full source: pass `source` with `base_version_id` (+ optional `base_content_hash`).
   - Find / replace: pass `find` + `replace` (+ `replace_all`, `expected_replacements`).
   - Checkpoint only: pass `checkpoint: true` with no `source`/`find`.
4. `validate_page_source` is read-only and accepts an in-memory `source` for pre-flight checks.
5. To verify review state, call `fetch` with `include: ["comments", "review_events"]` and an optional `status` filter (`open` | `resolved` | `all`).
6. `update_thread` with `body`, optional `resolve`/`status`/`anchor`/`complete`, and the agent attribution fields (`agent_name`, `agent_model`, `agent_session_id`).

Every content change advances `version_id`, even when no checkpoint record is created.

For structured new pages, call `create_page` with an optional `template_id` so the agent starts from the workspace's expected format.

CLI review flows use `vpg pages wait` plus the `vpg comments *` group. Add `--agent` for non-interactive JSON / NDJSON output.
