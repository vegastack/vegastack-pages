# ADR 001: Primary Runtime And MCP Placement

Status: Accepted for initial planning  
Date: 2026-05-10

## Context

VegaStack Pages needs to serve a dynamic documentation app with authentication, permissions, comments, source editing, public links, and Remote MCP. The project also needs a self-hosted open-source path that is simple for small teams.

The user wants:

- Cloudflare-first self-hosting.
- Astro 6.3.
- Remote MCP support.
- CLI support.
- No separate MCP deployment unless needed.
- Docker/Node portability.

## Decision

Use Astro SSR as the application framework.

Primary runtime:

- Cloudflare Workers through `@astrojs/cloudflare`.

Secondary runtime:

- Node through `@astrojs/node` and Docker.

Mount Remote MCP at:

```text
/mcp
```

inside the main Astro app for v1. Keep MCP implementation in:

```text
packages/mcp
```

Do not create a separate `apps/mcp-worker` in v1.

## Rationale

Cloudflare Workers fit the primary self-host target and integrate with D1, R2, Durable Objects, Workers assets, Cloudflare Email Service, and AWS SES through Worker secrets.

Astro SSR supports dynamic authenticated pages while still allowing a mostly static, low-JavaScript reading experience.

Keeping MCP in the main app for v1 reduces deployment complexity:

- One Worker.
- One auth/session model.
- One set of D1/R2 bindings.
- One permission layer.
- Simpler local development.

MCP can be split later if protocol, traffic, or operational constraints require it. Cloudflare Service Bindings make this possible, but starting with multiple Workers adds avoidable complexity.

## Consequences

Positive:

- Faster v1 implementation.
- Easier one-command deploy.
- Shared auth and permissions.
- Less duplicated infrastructure.

Negative:

- MCP and app traffic share one Worker deployment.
- Future scale isolation may require a migration to a separate Worker.

Mitigation:

- Keep MCP logic isolated in `packages/mcp`.
- Keep app/API/MCP contracts clean.
- Avoid coupling MCP handlers to Astro components.
