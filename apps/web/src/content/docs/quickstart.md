---
title: Quickstart
description: Sign up or self-host, create a page from source or template, and share it for review.
category: Getting started
order: 20
lastUpdated: 2026-05-14
---

This page gets you to a shared review page. Pick managed hosting or self-hosting first.

## Option A: Managed hosting

1. Open [pages.vegastack.com/app/signup](https://pages.vegastack.com/app/signup).
2. Enter your display name, email, and a workspace name.
3. Check your inbox for the magic link and click it.
4. Open the seeded workspace page.

Managed hosting runs on the same app and storage model as self-hosting. VegaStack operates the infrastructure.

Managed MCP endpoint:

```text
https://pages.vegastack.com/mcp
```

## Option B: Self-host on Cloudflare

```sh
git clone https://github.com/vegastack/vegastack-pages.git
cd vegastack-pages
corepack enable
pnpm install
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
pnpm deploy:cloudflare -- --apply-migrations --deploy
```

Open `https://pages.example.com/app/setup` and enter the same `VPG_SETUP_TOKEN` value. The full Cloudflare install reference is in `install/cloudflare/README.md`.

## Publish a page

From the app, click **New page**, paste Markdown or MDX, and save.

To start from a template, click **New from template** and choose a built-in template such as PRD, RFC, runbook, launch plan, or meeting notes.

## Connect an MCP client

Three ways to connect, from least to most setup:

- **Browser-based clients** (Claude.ai, ChatGPT custom connectors, Cursor remote MCP, …). Paste `https://pages.vegastack.com/mcp` (or your self-host equivalent) into the connector form. The client discovers OAuth via `/.well-known/oauth-protected-resource`, opens a consent popup, you sign in and pick a workspace, done.
- **Manual bearer.** Open **Settings → My Connections**, click **Create token**, copy the value. Use it as `Authorization: Bearer <token>` from Claude Desktop, Cursor local MCP, MCP-over-stdio bridges, or anything that accepts a static token.
- **CLI login.** `vpg login` starts the browser device-code flow against the managed service. For CI or headless use, `vpg login --token <token>` stores a manual bearer locally and pins a workspace.

From an MCP client, call:

```js
await mcp.call("create_page", {
  workspace_id: "wks_123",
  title: "Plan",
  source_type: "markdown",
  source: "# Plan\n\nDraft content for review.",
});
```

Or create from a template:

```js
await mcp.call("create_page_from_template", {
  workspace_id: "wks_123",
  template_id: "prd",
  title: "Search redesign",
  properties: {
    owner: "platform",
    status: "review",
  },
});
```

## Share it

Open the share dialog from the page header. Choose **Comment**, copy the link, and send it. The page lives at `/p/page-title-abc123000000` and is reachable by anyone with the link.

## Let the agent wait

```js
await mcp.call("wait_for_review", {
  workspace_id: "wks_123",
  page_id: "pg_123",
  until: "first_response",
  timeout_ms: 600000,
});
```

When the reviewer comments, the agent can read the thread, patch source with a current version token, reply, and wait again.
