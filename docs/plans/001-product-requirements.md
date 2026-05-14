# VegaStack Pages Product Requirements

Status: Draft requirements from discovery interview  
Date: 2026-05-10  
Project name: VegaStack Pages  
Package name: `@vegastack/pages`  
Primary commands: `vpg`, `vegastack-pages`  
License: MIT

## Product Intent

VegaStack Pages is an open-source, self-hostable documentation review and publishing system for agent-assisted software teams. It gives AI agents a reliable way to create readable documents, share review links, receive precise inline comments, and reply to review threads without forcing users to inspect local files.

The primary audience is users working with coding agents such as Claude Code, Codex, OpenClaw, Hermes Agent, Cursor-based agents, and other MCP-capable clients. The product should feel like a modern document app for humans and a dependable protocol surface for agents.

The managed VegaStack Pages app will run at `pages.vegastack.com/app`. The open-source distribution must support self-hosting, with Cloudflare as the primary deployment target and Node/Docker as the secondary portability target. `pages.vegastack.com` is also the public product/docs domain.

## Core Problems

- Agent-generated docs are often created locally and are difficult for humans to read, review, and comment on.
- Reviewers need to select exact text and leave inline comments, while agents need the selected text and nearby context reliably.
- Agents need a standard review flow that can pause until human feedback arrives.
- Teams need multi-user documentation instances with folders, page permissions, public review links, and searchable docs.
- Self-hosters need a simple setup path using Cloudflare services without managing a large backend stack.
- Hosted users need a managed app where anyone can sign up, create a workspace, and use VegaStack Pages without running infrastructure.

## Goals

- Render Markdown, GFM, MDX, raw HTML, images, SVG, Mermaid diagrams, code blocks, and frontmatter metadata cleanly.
- Provide a Notion/Obsidian-like document experience with a rendered mode and source edit mode.
- Support inline text-range comments in rendered mode, with right-sidebar threads and agent replies.
- Store canonical docs durably in R2 or S3-compatible storage, with metadata and comments in D1/SQLite.
- Support multiple workspaces, folders, subfolders, inherited permissions, and public publications.
- Provide a hosted Remote MCP endpoint at `/mcp` and a CLI that agents can use in interactive and non-interactive modes.
- Make pages load quickly with Astro SSR, render caching, minimal hydration, and permission-aware search.
- Support Cloudflare Free for small teams where possible, while documenting production limits and optional paid features.
- Follow test-driven development with at least 80 percent coverage and WCAG 2.2 AA accessibility expectations.

## Non-Goals For MVP

- Full real-time collaborative editing with cursors.
- Malware scanning for attachments.
- Email notifications as a hard requirement.
- Terraform/OpenTofu install path.
- Separate MCP Worker deployment.
- Public signup as a default self-hosted behavior. Managed hosting explicitly supports public signup.

## Users And Roles

- Instance admin: created during first setup. Manages instance settings, workspace creation, OAuth providers, retention defaults, and admin audit views.
- Workspace admin: manages users, folders, permissions, publications, workspace settings, and page organization.
- Editor: creates and edits pages where permitted.
- Commenter: reads and comments where permitted.
- Reader: reads where permitted.
- Guest reviewer: accesses a public link and must enter a display name before commenting or editing.
- Agent session: workspace-scoped MCP bearer session created by an authenticated workspace admin, shown once, and revocable.

## Document Model

Everything visible in the content tree is called a page. Folders are organizational containers for pages and child pages. Pages may represent regular docs, specs, plans, runbooks, `SKILL.md` files, HTML pages, or other structured documents.

Supported source types:

- Markdown
- GitHub Flavored Markdown
- MDX
- Raw HTML

Supported rendered elements:

- Images stored in page attachments
- SVG uploads with sanitization or safe serving headers
- Mermaid diagrams
- Code blocks with syntax highlighting, copy buttons, title or filename metadata, and clean formatting
- Tables, task lists, callouts, links, headings, lists, blockquotes, and frontmatter tables
- First-class `SKILL.md` rendering with metadata, instructions, file tree, references, and compatibility hints

## Editing UX

The editor has two simple modes with icon buttons inspired by Obsidian:

```text
[eye icon rendered mode] [pencil icon source edit mode]
```

Rendered mode:

- Polished document view.
- Serif typography for document content.
- Inline comment highlights.
- Right-sidebar thread panel.
- Table of contents.
- Frontmatter metadata table.
- Copy buttons on code blocks.

Source edit mode:

- Full-page CodeMirror 6 source editor.
- Markdown, MDX, or HTML source depending on page type.
- Autosave with conflict handling.
- Explicit source mode for HTML pages.
- MDX remains source-first to preserve arbitrary agent-authored MDX safely.

No split/live preview is required as the default UX. A lightweight preview action may exist later, but the primary model is smooth switching between rendered and source modes.

## Comments And Review

Users can select rendered text and add inline comments. Comments appear as highlights in the document and as threads in the right sidebar.

Requirements:

- Store selected text, source offsets, rendered DOM path, surrounding prefix/suffix text, and fuzzy re-anchor metadata.
- Unresolved comments visibly mark text.
- Resolved comments are hidden by default, with a way to reveal them.
- Threads support replies, resolve/unresolve, edit/delete where permitted, and agent responses.
- Agent responses are special typed replies with metadata: agent name, model, session ID, user account, timestamp.
- Guest users must enter a display name before commenting or editing through public links.

Agents can create pages and wait for review events. Wait conditions include:

- `first_response`
- `new_comment`
- `all_threads_resolved`
- `timeout`

## Storage And Versioning

Canonical editable source is stored in object storage.

Cloudflare mode:

- R2 stores Markdown/MDX/HTML source, attachments, snapshots, and render cache artifacts.
- D1 stores metadata, users, permissions, comments, anchors, versions metadata, public publications, search index records, audit logs, and sessions where suitable.
- Durable Objects coordinate live review sessions and delivery where needed.

Node mode:

- SQLite or Postgres for relational data.
- S3-compatible object storage or local filesystem for source and attachments.
- Node server process handles event streaming.

R2 path pattern mirrors folder hierarchy for backup and download ergonomics:

```text
workspaces/{workspaceSlugOrId}/pages/{folder-path}/{page-slug}-{id}/source/current.md
workspaces/{workspaceSlugOrId}/pages/{folder-path}/{page-slug}-{id}/versions/{timestamp}-{versionId}.md
workspaces/{workspaceSlugOrId}/pages/{folder-path}/{page-slug}-{id}/attachments/{attachmentId}/{filename}
workspaces/{workspaceSlugOrId}/pages/{folder-path}/{page-slug}-{id}/render-cache/{contentHash}.html
```

Versioning:

- Default retention is 30 days.
- Retention is configurable in hosting config and workspace settings.
- Autosaves update draft state.
- Durable versions are checkpointed, not created for every keystroke.
- Checkpoints are created on time-window intervals, publish/share milestones, manual named snapshots, and major source changes.

## URLs And Sharing

Public page links use:

```text
/p/page-title-abc123
```

The suffix must be globally unique and reliable across workspaces. If a user belongs to multiple workspaces, page lookup must resolve by globally unique page ID, then enforce user/publication permissions.

Public links:

- Use hidden grant tokens internally.
- The visible URL remains clean and human-readable.
- Support `view`, `comment`, and `edit`.
- Support optional expiry.
- Support optional password.
- Default permission is `view`.
- Grant access only to the linked page, not sibling pages or parent folders.
- Public pages default to `noindex`.
- Indexing can be explicitly enabled from the share menu.

## Permissions

Permission levels:

- No access
- Read
- Comment
- Read-write
- Admin/manage

Permissions apply at instance, workspace, folder, and page levels. Folder permissions inherit downward unless explicitly overridden. Attachments are private by default and served through permission-checked URLs.

Ctrl+K search must respect permissions dynamically. Users must only see pages they are allowed to access.

## Search

Keyboard shortcuts:

- `Cmd/Ctrl+F`: browser-like current-page search.
- `Cmd/Ctrl+K`: global command palette and page search across accessible pages.

Search approach:

- Private/searchable workspace content uses D1 FTS5 or the Node-mode database equivalent.
- Search queries are permission-filtered server-side.
- Pagefind may be added later for explicitly public, indexable static pages.

## Setup And Onboarding

First open shows a Ghost-like setup wizard.

Setup creates:

- First admin account through email magic link or temporary setup token/password shown in deploy logs.
- First workspace.
- Seed folders.
- Get Started page.
- MCP/CLI quickstart page.
- Optional default skill/reference pages.

Self-hosted instances default to no public signup. Admins invite users after setup. Managed hosting enables public signup and creates a first workspace for each new account.

Auth:

- Email magic link required.
- Google OAuth optional and disabled until configured.

## CLI And MCP

The CLI is a Rust binary distributed through npm package `@vegastack/pages`.

Commands:

- `vpg`
- `vegastack-pages`

Both aliases must work.

Remote MCP:

- Mounted at `/mcp` in the main Astro app for v1.
- Uses Streamable HTTP where supported.
- Browser-based OAuth/login flow.
- Tools are workspace-scoped after login.
- No instance-admin MCP tools in v1 unless explicitly enabled later.

CLI and MCP should share API semantics and naming.

## Deployment

Managed hosting:

- Hosted at `pages.vegastack.com/app`.
- Public signup enabled.
- Signup creates or reuses a user account, creates a workspace when needed, seeds starter pages, and sends a magic link.
- Workspaces are tenant-isolated by workspace ID and permission checks. Page URLs remain global `/p/page-title-abc123`; access is resolved by the page record plus the authenticated user or public publication.

Primary deployment:

- Cloudflare Workers with Astro SSR.
- D1, R2, Durable Objects, Workers assets, and optional Email Service binding.
- One-command deploy script creates required resources using an account API token with documented permissions.

Secondary deployment:

- Docker/Node self-host mode.
- S3-compatible storage through config.
- SQLite or Postgres depending on implementation phase.

Install directories:

```text
install/cloudflare/
install/docker/
```

## Email

In-app and MCP notifications are core. Email delivery is optional and used for magic links and invites when a provider is configured.

The provider interface supports Cloudflare Email Service and AWS SES. Cloudflare Email Service may require Workers Paid for sending, so email cannot be a hard free-plan dependency.

## Design System

- Vega neutral color tokens with light, dark, and system themes.
- Modern serif font for document content.
- Geist for application UI.
- Clean, modern, dense enough for docs workflows.
- Inspired by Mintlify for documentation rendering and table of contents.
- Inspired by Notion for page tree, comments, sharing, and setup polish.
- Inspired by Obsidian for simple rendered/source mode switching.
- Cards should be restrained and not nested.
- UI must work cleanly on desktop, tablet, and mobile.

## Performance Targets

Targets are product goals, not guarantees:

- Cached shell TTFB under roughly 300 ms in common Cloudflare regions.
- Normal document open under roughly 1 second after auth.
- Comment submission visible immediately in the UI.
- Minimal JavaScript on read pages.
- React only for interactive islands such as editor, comments, search, and command palette.
- Render caching keyed by content hash.

## Accessibility

WCAG 2.2 AA is a v1 acceptance criterion.

Required:

- Keyboard navigable document tree, editor controls, command palette, share dialog, and comments.
- Visible focus states.
- Color contrast in light, dark, and system theme modes.
- Screen reader labels for icon-only mode buttons.
- Accessible comments and selected text highlights.

## Acceptance Criteria

- Agent can create a page through CLI or MCP.
- User can open `/p/page-title-abc123`, read, edit, comment, resolve threads, and share.
- Agent can wait for comments and receive selected text context.
- Markdown, MDX, HTML, Mermaid, SVG, images, code blocks, and metadata render safely.
- Workspace permissions and public links behave correctly.
- Ctrl+K never leaks inaccessible pages.
- Cloudflare installer can create resources and deploy with documented token permissions.
- Docker/Node path is documented and runnable.
- Test coverage is at least 80 percent.
