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

Production deployments should create workspace-scoped MCP sessions in **Settings > MCP**. Static MCP tokens are a local/debug path and require `VPG_ALLOW_STATIC_MCP_TOKEN=true` plus `VPG_MCP_WORKSPACE_ID` if explicitly enabled outside dev.

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

## Agent Edit Flow

Use this sequence for reliable edits:

1. `prepare_page_edit`
2. Modify the returned live `source`
3. `patch_page` for focused replacements, or `update_page` with `base_version_id` and `base_content_hash`
4. `validate_page_source`
5. `list_comments` with `status: "all"` when verifying review state
6. `complete_review_thread` to reply and optionally resolve

Every content change advances `version_id`, even when no checkpoint record is created.

For structured new pages, prefer `create_page_from_template` so the agent starts from the workspace's expected format.
