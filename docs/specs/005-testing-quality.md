# Testing And Quality Specification

Status: Draft  
Date: 2026-05-10

## Quality Bar

VegaStack Pages must be built with test-driven development where practical. Every critical behavior needs automated coverage before or alongside implementation.

Coverage target:

- Minimum 80 percent overall coverage.
- Critical permission, sharing, auth, comment, and agent flows require focused tests regardless of aggregate percentage.

Accessibility:

- WCAG 2.2 AA is a v1 acceptance criterion.

## Test Stack

- Vitest for TypeScript unit tests.
- Playwright for browser flows and visual interaction checks.
- Rust `cargo test` for CLI.
- Drizzle migration tests.
- API contract tests for CLI/MCP shared behavior.
- Accessibility tests using Playwright plus axe or equivalent.

## Required Test Areas

### Permissions

Test:

- Workspace membership.
- Folder permission inheritance.
- Page override.
- Public link grants.
- Public links do not expose sibling pages.
- Attachment access checks.
- Ctrl+K permission filtering.
- MCP workspace scope.
- CLI workspace scope.

### Auth

Test:

- First-run setup.
- Magic link login.
- Setup token expiry.
- Google OAuth disabled until configured.
- Invite-only user creation.
- Guest display name required.

### Pages

Test:

- Create Markdown page.
- Create MDX page.
- Create HTML page.
- Rename/move page.
- Folder/subfolder tree.
- Global `/p/page-title-abc123` resolution.
- Autosave conflict handling.
- Version checkpointing and retention cleanup.

### Rendering

Test:

- Frontmatter table.
- GFM tables/task lists.
- Code blocks with copy controls.
- Mermaid block placeholder/render.
- SVG upload safety behavior.
- HTML sandbox behavior.
- `SKILL.md` first-class rendering.
- Render cache invalidation.

### Comments

Test:

- Select text and create comment.
- Anchor metadata stored.
- Re-anchor after small edit.
- Resolve/unresolve.
- Resolved hidden by default.
- Agent response metadata.
- Guest comment attribution.

### MCP

Test:

- Login required.
- Workspace selected.
- `create_page`.
- `wait_for_review`.
- `list_comments`.
- `reply_to_thread`.
- `resolve_thread`.
- Structured errors.
- Permission denial.

### CLI

Test:

- `vpg` alias.
- `vegastack-pages` alias.
- JSON output.
- Exit codes.
- Non-interactive mode.
- Config validation.
- Login token handling abstraction.
- Create/wait/reply flows using mocked API.

### Deployment

Test:

- Cloudflare config generation.
- Missing API token permissions reported clearly.
- D1 migration ordering.
- Docker config validation.
- Setup wizard first-run state.

## Playwright Scenarios

Minimum end-to-end flows:

1. First setup creates admin and workspace.
2. Admin creates page, edits source, sees rendered page.
3. User creates inline comment and resolves it.
4. Public comment link works for guest with display name.
5. Agent creates page through API/CLI and waits for comment.
6. Ctrl+K only returns accessible pages.
7. Mobile read/comment flow works.
8. Mobile source edit mode works without broken layout.

## Performance Checks

Add regression checks for:

- Read page initial JS size.
- Render cache hit behavior.
- Search response time on seeded data.
- Comment submit latency under local test.

## Accessibility Checks

Required checks:

- Keyboard navigation through page tree.
- Keyboard access to comments.
- Dialog focus trapping.
- Icon button labels.
- Color contrast.
- Screen reader labels for mode switch.
- No text overlap on mobile/desktop.

## CI Gates

Required CI jobs:

- Install.
- Format.
- Lint.
- Typecheck.
- Unit tests.
- Migration tests.
- Rust tests.
- Playwright smoke.
- Coverage report with threshold.
