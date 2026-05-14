# Implementation Playbook

Status: Draft  
Date: 2026-05-10

## Purpose

This is the cold-start guide for an implementation agent. It assumes no memory of the discovery chat.

## First Steps In A Fresh Session

1. Read `docs/README.md`.
2. Read all `docs/plans/*.md`.
3. Read all `docs/specs/*.md`.
4. Read `docs/adr/*.md`.
5. Inspect local Astro 6.3 docs before writing Astro code:

```text
/Users/mk/projects/ref-docs/astro-js-docs
```

6. Verify current external docs before implementing volatile integrations:
   - Cloudflare Workers/D1/R2/Durable Objects/Email Service.
   - MCP transport and authorization.
   - Drizzle D1.
   - Tailwind v4.
   - CodeMirror 6.

## Scaffold Order

Implement in this order:

1. Monorepo package manager and root config.
2. Shared config package.
3. DB package with Drizzle schema and migrations.
4. Core domain package with ID, permission, and error primitives.
5. Renderer package with Markdown/GFM/frontmatter baseline.
6. Astro web app shell.
7. Setup wizard and auth baseline.
8. Workspace/page tree.
9. Page create/read/render.
10. Source edit mode with CodeMirror.
11. Autosave and checkpoint versions.
12. Comments and anchors.
13. Publications.
14. Search.
15. CLI skeleton and core commands.
16. MCP endpoint and tools.
17. Cloudflare deploy installer.
18. Docker/Node installer.

Do not start with advanced MDX, Mermaid, or email before the Markdown/comment/review loop is working.

## Initial Monorepo Shape

```text
apps/web
packages/config
packages/core
packages/db
packages/renderer
packages/mcp
packages/ui
cli/vegastack-pages
install/cloudflare
install/docker
docs
```

## Root Tooling

Expected:

- `pnpm-workspace.yaml`
- root `package.json`
- TypeScript config base
- ESLint or equivalent
- Prettier or equivalent
- Vitest config
- Playwright config
- Rust toolchain file if needed
- CI config once repository is initialized

## Naming Rules

Use exactly:

- Product: VegaStack Pages.
- Package: `@vegastack/pages`.
- CLI aliases: `vpg`, `vegastack-pages`.
- Config: `vegastack-pages.yaml`.
- App folder: `apps/web`.
- MCP package: `packages/mcp`.
- CLI folder: `cli/vegastack-pages`.
- Install folders: `install/cloudflare`, `install/docker`.

Do not introduce `VegaPages`, `vegapages`, `crates/`, or `examples/`.

## Source Of Truth Rules

- R2/S3 current source is canonical for page content.
- D1/SQLite is canonical for metadata, permissions, comments, search, and audit logs.
- Render cache can be regenerated.
- Search index can be regenerated.
- Public link raw tokens are shown only once.
- Share token hashes are stored, not raw tokens.

## Definition Of Done For MVP Loop

The first useful vertical slice is:

1. Deploy locally.
2. Complete setup.
3. Create workspace.
4. Create Markdown page.
5. Open `/p/page-title-abc123`.
6. Switch between rendered/source modes.
7. Edit and autosave source.
8. Add inline comment in rendered mode.
9. Resolve comment.
10. Create public comment publication.
11. Guest opens link, enters display name, comments.
12. CLI creates a page and waits for first response.
13. Tests cover the flow.

## Package Choices To Confirm Before Install

Do not install packages blindly. Verify current compatibility first.

Likely choices:

- Astro 6.3.
- `@astrojs/cloudflare`.
- `@astrojs/node`.
- React integration for Astro.
- Tailwind CSS v4.
- Drizzle ORM.
- CodeMirror 6 packages.
- unified/remark/rehype ecosystem.
- Shiki or Expressive Code-compatible renderer.
- Mermaid.
- Zod or equivalent schema validation.
- Playwright.
- Vitest.
- Rust `clap` or equivalent for CLI argument parsing.
- Rust HTTP client suitable for TLS and JSON API calls.

## Implementation Guardrails

- Keep Cloudflare-specific code behind provider adapters.
- Keep MCP handlers separate from Astro components.
- Keep renderer deterministic and cacheable.
- Keep permission checks centralized.
- Do not expose R2/S3 public URLs.
- Do not rely on client-side search for private content.
- Do not add rich text editing in v1.
- Do not add separate MCP Worker in v1.
- Do not require Cloudflare Paid for core small-team usage.

## Test-First Requirements

Before implementing each feature, write or update tests for:

- Happy path.
- Permission denial.
- Invalid input.
- Conflict behavior if mutating content.
- Accessibility where UI is involved.

Critical paths must have tests even if coverage already exceeds 80 percent.

## Known Deferred Items

Deferred by decision:

- Email notifications.
- Malware scanning.
- Turnstile.
- Terraform/OpenTofu.
- Separate MCP Worker.
- Real-time collaborative editing.
- Public Pagefind for private docs.
