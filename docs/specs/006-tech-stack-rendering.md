# Tech Stack And Rendering Specification

Status: Draft  
Date: 2026-05-10

## Stack Summary

VegaStack Pages should use a modern, mostly TypeScript web stack with a Rust CLI.

Core:

- Astro 6.3.
- Cloudflare Workers primary adapter.
- Node adapter for Docker self-host.
- React islands for interactive document surfaces.
- Tailwind CSS v4 for app styling.
- Vega neutral design tokens.
- Geist for application UI text.
- Modern serif font for document content.
- CodeMirror 6 for source editing.
- Drizzle ORM for D1/SQLite schema and migrations.
- Rust for CLI.

## Astro

Astro is used for:

- Server-rendered routes.
- Layouts.
- Static assets.
- API routes.
- Minimal hydration.
- Build-time docs and seed docs through content collections.

Astro content collections are suitable for:

- Built-in app docs.
- Seed content.
- Static reference docs.
- Developer documentation.

Astro content collections are not the main user-doc runtime because R2/S3 user documents change at runtime and MDX runtime rendering has important constraints. Runtime workspace pages use the VegaStack Pages renderer package.

## React Islands

Use React only where interactivity needs it:

- Source editor wrapper.
- Comment sidebar.
- Inline comment interactions.
- Command palette.
- Search results.
- Share dialog.
- Setup wizard.

Read mode should stay mostly server-rendered HTML with small islands.

## Styling

Use Tailwind CSS v4 through the modern Vite/Astro integration path.

Requirements:

- Vega neutral color tokens exposed as CSS variables.
- Geist loaded for app UI.
- Document content uses a modern serif.
- Code uses a readable monospace.
- Light, dark, and system modes are supported through token variants and a persisted user preference.
- Avoid one-note palettes.
- No nested UI cards.
- Icon-only buttons require accessible labels.

## Editor

Use CodeMirror 6.

Modes:

- Markdown.
- MDX as source text with MDX-aware highlighting where practical.
- HTML source mode.

Requirements:

- Autosave.
- Conflict token.
- Save status.
- `Cmd/Ctrl+S` force save/checkpoint.
- Keyboard behavior must not fight CodeMirror defaults.
- Mobile source editing must be usable.

## Markdown Renderer

Use a unified/remark/rehype style pipeline.

Features:

- YAML frontmatter.
- GitHub Flavored Markdown.
- Tables.
- Task lists.
- Autolinks.
- Strikethrough.
- Heading extraction.
- Slug generation.
- Table of contents.
- Sanitized HTML allowlist.
- Comment anchor mapping.

## Code Blocks

Use Shiki directly or through an Expressive Code-compatible setup.

Required:

- Syntax highlighting for common programming languages.
- Copy button.
- Filename/title metadata.
- Good wrapping behavior.
- Accessible copy feedback.
- Light/dark theme alignment with Vega neutral tokens.

Nice-to-have later:

- Line highlights.
- Diff highlighting.
- Collapsible long blocks.

## MDX

MDX is source-first.

Rules:

- Allow registered safe components by default.
- Avoid arbitrary untrusted runtime execution.
- Preserve source fidelity for agent-authored docs.
- Do not use rich text editing for MDX in v1.
- Render with explicit component policy and cache key.

## HTML

HTML pages are supported but treated carefully.

Rules:

- Render arbitrary HTML in a sandboxed iframe by default.
- Support responsive iframe viewport behavior.
- Allow comments on rendered HTML where technically feasible.
- Source editing must be explicit.
- Trusted same-tab preview may be added later for admins with warnings.

## Mermaid

Mermaid support should start client-side for broad compatibility and fewer server-runtime issues.

Requirements:

- Render fenced Mermaid blocks.
- Support common Mermaid diagram types.
- Show accessible fallback text if rendering fails.
- Avoid blocking initial document render.

Future:

- Pre-render/cache SVG output if performance or consistency demands it.

## Images And SVG

Images:

- Stored as attachments in R2/S3.
- Served through permission-checked URLs.
- Optimized/compressed where supported by Astro image services and runtime constraints.
- Use Astro defaults and Sharp-compatible build-time processing where feasible.
- In Cloudflare mode, account for `@astrojs/cloudflare` image service options such as compile-time processing or Cloudflare bindings.

SVG:

- Support uploaded SVG.
- Sanitize before inline rendering or serve as file with safe headers.
- Do not allow unsafe SVG script behavior.

## SKILL.md Rendering

`SKILL.md` gets a first-class page type.

Render:

- Frontmatter metadata table.
- Skill name.
- Description.
- User-invocable status.
- Allowed tools.
- Argument hint.
- Instructions.
- Referenced files.
- Folder tree where available.
- Compatibility notes for Codex, Claude Code, Hermes, OpenClaw, and other agent clients.

The renderer should make skills easy to inspect the way dedicated skill registries do, while preserving original Markdown source.

## Search

Private search:

- D1 FTS5 in Cloudflare mode.
- SQLite FTS5 in Node mode.
- Permission-filtered server-side.

Public indexed search:

- Optional future Pagefind integration only for explicitly public/indexable exports.

## References To Verify During Implementation

- Local Astro 6.3 docs: `/Users/mk/projects/ref-docs/astro-js-docs`
- Astro Cloudflare adapter docs.
- Astro Node adapter docs.
- Astro MDX docs.
- Astro image docs.
- CodeMirror 6 docs.
- Drizzle D1 docs.
- Tailwind CSS v4 docs.
- MCP Streamable HTTP transport docs.
- Cloudflare Workers/D1/R2/Durable Objects docs.
