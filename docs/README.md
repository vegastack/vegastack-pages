# VegaStack Pages Docs Index

This directory contains technical planning, architecture references, ADRs, specs, and local testing notes for VegaStack Pages.

Start here when changing implementation behavior:

1. [Product requirements](plans/001-product-requirements.md)
2. [Architecture](plans/002-architecture.md)
3. [Phased roadmap](plans/003-phased-roadmap.md)
4. [Managed hosting](plans/004-managed-hosting.md)
5. [Tech stack and rendering](specs/006-tech-stack-rendering.md)
6. [Data model and permissions](specs/002-data-model-permissions.md)
7. [API contracts](specs/007-api-contracts.md)
8. [MCP and CLI](specs/003-mcp-cli.md)
9. [Configuration and environment](specs/008-configuration-env.md)
10. [Security and trust boundaries](specs/009-security.md)
11. [Core implementation conventions](specs/011-core-conventions.md)
12. [UI and UX](specs/001-ui-ux.md)
13. [Deployment and self-hosting](specs/004-deployment-self-hosting.md)
14. [Testing and quality](specs/005-testing-quality.md)
15. [Implementation playbook](specs/010-implementation-playbook.md)
16. [ADR 001: runtime and MCP placement](adr/001-primary-runtime-and-mcp-placement.md)
17. [ADR 002: runtime renderer over content collections](adr/002-runtime-renderer-over-content-collections.md)
18. [Local development backend](local-development.md)
19. [MCP local testing](mcp-local-testing.md)

## Current Decisions

- Product name: VegaStack Pages.
- Managed product/docs domain: `pages.vegastack.com`.
- Managed app entry: `pages.vegastack.com/app`.
- Managed MCP endpoint: `pages.vegastack.com/mcp`.
- OSS npm package: `@vegastack/pages`.
- CLI aliases: `vpg` and `vegastack-pages`.
- CLI implementation: Rust binary distributed through npm.
- Repo shape: monorepo.
- App: Astro SSR.
- Primary runtime: Cloudflare Workers.
- Secondary runtime: Node/Docker.
- MCP: Remote MCP mounted at `/mcp` inside `apps/web`.
- MCP implementation package: `packages/mcp`.
- Install directories: `install/cloudflare` and `install/docker`.
- Source editor: CodeMirror 6.
- UI: React islands, Tailwind CSS v4, Vega neutral theme tokens, Geist, modern serif document content.
- Database: Drizzle ORM on D1/SQLite.
- Object storage: R2 in Cloudflare mode, filesystem object storage in Docker/Node mode.
- Search: permission-aware server-side search.
- Auth: setup admin for self-host, public signup for managed hosting, email magic link, optional Google OAuth, invite-only users where configured.
- Public links: view/comment/edit, optional expiry, optional password, default noindex.
- Templates: workspace-scoped structured page scaffolds with typed properties and agent guidance comments.
- Backup to Git: optional GitHub App sync for pages, templates, optional assets, and a manifest.

## Reference Checks

Before implementing Astro-specific behavior, inspect the local Astro docs when available:

```text
/Users/mk/projects/ref-docs/astro-js-docs
```

Relevant local docs:

- `src/content/docs/en/guides/integrations-guide/cloudflare.mdx`
- `src/content/docs/en/guides/deploy/cloudflare.mdx`
- `src/content/docs/en/guides/integrations-guide/node.mdx`
- `src/content/docs/en/guides/integrations-guide/mdx.mdx`
- `src/content/docs/en/guides/actions.mdx`
- `src/content/docs/en/guides/sessions.mdx`
- `src/content/docs/en/guides/syntax-highlighting.mdx`

Use current upstream docs for Cloudflare limits, Wrangler flags, and platform pricing.
