# VegaStack Pages Architecture

Status: Draft  
Date: 2026-05-10

## Architecture Summary

VegaStack Pages is a monorepo with one primary Astro web app, shared TypeScript packages, and a Rust CLI. The main app hosts the browser UI, API routes, auth, and the Remote MCP endpoint at `/mcp`.

The primary runtime is Cloudflare Workers. The secondary runtime is Node through Docker for users who need to self-host outside Cloudflare.

## Repository Structure

```text
vegastack-pages/
  apps/
    web/                    # Astro app, API routes, auth, UI, /mcp endpoint
  packages/
    core/                   # domain services, permissions, page IDs, audit contracts
    config/                 # config parser, config schema, environment mapping
    db/                     # Drizzle schema, migrations, seed data
    renderer/               # Markdown/MDX/HTML rendering pipeline
    mcp/                    # MCP tools, resources, prompts, protocol handlers
    ui/                     # shared UI components, tokens, typography
  cli/
    vegastack-pages/        # Rust CLI, binary aliases: vpg and vegastack-pages
  install/
    cloudflare/             # deploy scripts, templates, docs
    docker/                 # Docker/Node self-host install
  docs/
    plans/
    specs/
    adr/
```

## Package Manager

Use `pnpm` for the monorepo because workspaces and lockfile behavior are better suited to this repo shape than npm alone.

Current source-checkout install commands:

```sh
export VPG_BASE_URL=https://pages.example.com
export VPG_SETUP_TOKEN="$(openssl rand -base64 32)"
pnpm deploy:cloudflare -- --apply-migrations --deploy
```

## Runtime Modes

### Cloudflare Mode

Cloudflare mode is the recommended installation.

Components:

- Astro 6.3 SSR with `@astrojs/cloudflare`.
- Cloudflare Workers for app/API/MCP.
- Workers static assets for built client assets.
- D1 for relational data and FTS search.
- R2 for document source, attachments, snapshots, and render cache artifacts.
- Durable Objects for live review/session coordination where needed.
- Workers Cron/Queues for retention cleanup, search indexing, and background jobs where available.
- Optional Cloudflare Email Service later.

Cloudflare Free should support small teams where usage stays within limits. Production docs must explain Free limits and recommend Workers Paid when teams need higher limits, email sending, or predictable overage behavior.

### Node/Docker Mode

Node mode exists for portability.

Components:

- Astro SSR with `@astrojs/node`.
- Docker image.
- SQLite initially, with Postgres optional later if needed.
- Filesystem object storage configured through `VPG_OBJECT_STORE_DIR` and mounted storage.
- S3-compatible object storage can be added later behind the storage provider interface.
- Event streaming handled by the Node process.

Business logic must not hard-code Cloudflare APIs. Storage, database, event, and email providers should be behind interfaces.

## Astro Usage

Use Astro content collections for:

- Built-in docs.
- Seed pages.
- Static documentation shipped with the app.
- Local developer docs.

Do not use Astro content collections as the main runtime engine for user-created R2 documents because user docs change at runtime and live content collections do not support runtime MDX rendering.

Use a VegaStack Pages runtime document pipeline for:

- R2/S3-backed Markdown, MDX, and HTML.
- Frontmatter extraction.
- Heading extraction.
- Metadata tables.
- Mermaid handling.
- Code highlighting.
- Sanitization.
- Comment anchor mapping.
- Render cache generation.

## Data Flow

### Page Open

1. Request hits `/p/{slugId}`.
2. App resolves the globally unique page ID.
3. Permission is checked against logged-in user or public publication.
4. Page metadata is loaded from D1/SQLite.
5. Current source is loaded from R2/S3.
6. Render cache is checked by content hash and renderer version.
7. If cache miss, source is rendered and sanitized.
8. Comments and anchors are loaded.
9. Astro renders the page shell and document content.
10. React islands hydrate only comments/search/editor controls.

### Page Edit

1. User enters source edit mode.
2. CodeMirror loads source.
3. Autosave sends content and current version token.
4. API checks permission and conflict token.
5. Draft/current source is written to R2/S3.
6. Metadata, search status, and version checkpoint state are updated.
7. Background indexing/render-cache invalidation runs.
8. If checkpoint rules are met, a durable version object is written.

### Comment Creation

1. User selects text in rendered mode.
2. Browser captures selected text, source offsets when available, DOM path, and context snippets.
3. API validates page permission and creates comment thread.
4. D1/SQLite stores thread, anchor metadata, and audit event.
5. UI updates immediately.
6. Waiting agents receive event through MCP stream or CLI wait/poll fallback.

### Agent Review

1. Agent creates a page with CLI or MCP.
2. API returns `/p/page-title-abc123`.
3. Agent may wait for a condition.
4. Human reviews in browser.
5. Comments flow back to the agent with selected text and context.
6. Agent replies to threads using MCP or CLI.

## Core Interfaces

Provider interfaces:

- `ObjectStore`: get/put/delete/list/signed access for source and attachments.
- `Database`: Drizzle-backed D1/SQLite connection and migrations.
- `EventBus`: live review and notification events.
- `EmailProvider`: optional, no hard dependency in v1.
- `AuthProvider`: magic link and Google OAuth.
- `SearchIndexer`: D1 FTS5 or Node database equivalent.

Domain services:

- `PageService`
- `FolderService`
- `PermissionService`
- `ShareLinkService`
- `CommentService`
- `RenderService`
- `VersionService`
- `AuditService`
- `AgentSessionService`

## Rendering Pipeline

Markdown pipeline:

- Parse frontmatter.
- Parse GFM.
- Support tables, task lists, autolinks, strikethrough.
- Extract headings for table of contents.
- Render code blocks with Shiki or Expressive Code-compatible approach.
- Render Mermaid blocks client-side initially.
- Sanitize rendered HTML with a strict allowlist.

MDX pipeline:

- Source-first editing.
- Safe registered component allowlist by default.
- Avoid arbitrary runtime code execution in untrusted contexts.
- Extract frontmatter and headings.
- Preserve agent-authored MDX where possible.

HTML pipeline:

- View/comment mode uses sandboxed iframe for arbitrary HTML.
- Admin/trusted preview may later allow same-tab rendering with strong warnings.
- Source edit mode is explicit.
- HTML comments anchor to rendered iframe content where feasible, with fallback to source text anchors.

SVG handling:

- Sanitize uploaded SVG or serve with safe content headers.
- Do not inline untrusted SVG without sanitization.

## Search Architecture

Private search uses server-side FTS.

Cloudflare mode:

- D1 FTS5 virtual table or equivalent schema.
- Indexed fields: title, headings, frontmatter text, body text, page path, tags.
- Search query joins permission filters before returning results.

Node mode:

- SQLite FTS5 initially.
- Postgres full-text search can be added later.

Pagefind:

- Optional future feature for explicitly public and indexable static exports.
- Not used for private Ctrl+K search because client indexes can leak content.

## MCP Architecture

MCP lives in `packages/mcp` and is mounted by `apps/web` at `/mcp`.

Rationale:

- One deployment target in v1.
- Shared auth/session handling.
- Shared D1/R2 bindings.
- Simpler local development.
- Fewer cross-Worker consistency issues.

Future split:

- Add `apps/mcp-worker` only if traffic isolation, protocol limitations, or deployment needs require it.
- Use Cloudflare Service Bindings for internal app-to-MCP communication if split.

## Security Architecture

Security defaults:

- Private attachments.
- Permission-checked access to source, rendered pages, comments, and search.
- Public links use secret grants internally.
- Public signup disabled by default in self-host mode; enabled only in managed mode or explicit config.
- Guest display name required for public comment/edit.
- Magic-link auth and optional Google OAuth.
- Workspace-scoped MCP bearer sessions created by authenticated workspace admins.
- CLI commands use explicit bearer auth when the target API accepts it.
- Admin audit log for sensitive actions.
- Sanitized Markdown and restricted MDX components.
- Sandboxed raw HTML rendering.

## Performance Architecture

- Astro SSR for dynamic auth and permissions.
- Cache render output by content hash, renderer version, and component policy.
- Hydrate only interactive islands.
- Use optimistic UI for comments and autosave.
- Avoid server-side Mermaid rendering in v1 unless needed.
- Use durable version checkpoints instead of per-keystroke snapshots.
- Keep document read mode low-JavaScript.

## References

- Astro 6.3 local docs: `/Users/mk/projects/ref-docs/astro-js-docs`
- Astro Cloudflare adapter docs
- Astro Node adapter docs
- Cloudflare Workers, D1, R2, Durable Objects, Email Service docs
- MCP Streamable HTTP transport and authorization specs
- CodeMirror 6 docs
- Drizzle ORM D1 docs
- Tailwind CSS v4 docs
