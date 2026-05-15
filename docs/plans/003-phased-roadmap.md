# VegaStack Pages Phased Roadmap

Status: Draft  
Date: 2026-05-10

## Phase 0: Research And Foundations

Goal: Lock architecture and establish repo skeleton before feature work.

Deliverables:

- Monorepo structure.
- MIT license.
- `pnpm` workspace.
- Astro 6.3 app in `apps/web`.
- Shared package skeletons.
- Rust CLI skeleton in `cli/vegastack-pages`.
- Drizzle schema baseline.
- Config schema for `vegastack-pages.yaml`.
- ADRs for runtime, MCP placement, renderer, and storage.
- CI with lint, typecheck, unit tests, Playwright smoke, and Rust tests.

Acceptance:

- Empty app deploys locally.
- CLI can print version and parse config.
- CI passes.

## Phase 1: Cloudflare MVP

Goal: A self-hosted Cloudflare instance can create, render, edit, comment on, and share Markdown pages.

Scope:

- Cloudflare Worker deployment through `install/cloudflare`.
- D1 migrations.
- R2 bucket setup.
- First-run setup wizard.
- Email magic-link auth or setup token.
- First admin creation.
- Workspace creation and seed pages.
- Page tree with folders/subfolders.
- Markdown/GFM render pipeline.
- Frontmatter metadata table.
- Rendered/source mode toggle.
- CodeMirror source editor.
- Autosave and conflict token.
- Version checkpointing.
- Inline comments on rendered text.
- Right-sidebar threads.
- Resolve/unresolve.
- Public publications with view/comment/edit, optional expiry, optional password.
- Permission inheritance.
- Attachment upload for images.
- Private attachment serving.
- Ctrl+F current page.
- Ctrl+K permission-aware page search using D1 FTS5.
- `vpg` and `vegastack-pages` commands for login, create, wait, comments, reply, deploy, doctor.

Acceptance:

- User can deploy with documented Cloudflare API token permissions.
- User can create a workspace and first page.
- Agent can create a page through CLI and receive review comments.
- Public comment link works for guest reviewer with display name.
- Inaccessible pages do not appear in Ctrl+K.
- Coverage is at least 80 percent.

## Phase 2: Remote MCP MVP

Goal: Agent clients can use hosted MCP over HTTP.

Scope:

- `/mcp` endpoint mounted in `apps/web`.
- Browser login/OAuth flow.
- Workspace-scoped session.
- Tools:
  - `create_page`
  - `update_page`
  - `get_page`
  - `wait_for_review`
  - `list_comments`
  - `update_thread`
  - `publication_apply`
  - `upload_attachment`
  - `search_workspace`
- Resources:
  - Page source
  - Page rendered metadata
  - Comment threads
  - Workspace tree
- Agent response metadata.
- Event delivery for comments and thread updates.
- CLI fallback behavior documented.

Acceptance:

- MCP client can login, create page, wait for comment, and reply.
- MCP tools enforce same permissions as web UI.
- MCP errors are machine-readable and stable.

## Phase 3: Rich Document Support

Goal: Support advanced docs used by agents and technical teams.

Scope:

- MDX rendering with safe component allowlist.
- Raw HTML page support in sandboxed view.
- Mermaid diagrams.
- SVG upload handling.
- First-class `SKILL.md` rendering.
- Table of contents improvements.
- Better code block metadata: filenames, titles, line wrapping, copy button.
- Image optimization path where compatible.
- Workspace export ZIP from object storage.

Acceptance:

- Agent-authored MDX renders without corrupting source editing.
- `SKILL.md` pages show metadata and references clearly.
- HTML pages can be viewed/commented and source-edited explicitly.

## Phase 4: Docker/Node Self-Host

Goal: Users can run VegaStack Pages outside Cloudflare.

Scope:

- `install/docker`.
- Astro Node adapter.
- SQLite database.
- S3-compatible object storage config.
- Local development storage option.
- Node-mode event streaming.
- Docker Compose example.
- Migration and backup docs.

Acceptance:

- Docker install runs locally.
- User can connect S3-compatible storage.
- Core flows match Cloudflare mode.

## Phase 5: Notifications And Operations

Goal: Improve production operations and team workflows.

Scope:

- In-app notifications.
- MCP notification subscriptions.
- Optional Cloudflare Email Service provider.
- Optional AWS SES provider.
- Admin audit log UI.
- Retention cleanup jobs.
- Usage and limits dashboard.
- Backup/export improvements.
- Update flow: `vpg update` (with `--check` and `--channel` flags) for in-place upgrades via the owning package manager.

Acceptance:

- Admin can inspect sensitive changes.
- Users can receive review notifications in-app and through MCP.
- Self-hosters can understand current version and migration status.

## Phase 6: Public Publishing And Static Search

Goal: Make VegaStack Pages useful as a public docs publishing surface.

Scope:

- Explicit public indexing toggle.
- Optional Pagefind for public/indexable static pages.
- Public docs theme polish.
- Sitemap and robots controls.
- Public read-only cache strategy.

Acceptance:

- Private pages remain unindexed by default.
- Public indexed pages can opt into search engine indexing.

## Phase 7: Enterprise And Security Enhancements

Later scope:

- Malware scanning.
- Turnstile for public links.
- SSO/SAML/OIDC beyond Google OAuth.
- Fine-grained audit export.
- Postgres first-class support.
- Separate MCP Worker if needed.
- Terraform/OpenTofu installer.
- Real-time collaborative editing.
- Advanced retention/legal hold policies.
