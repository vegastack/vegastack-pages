# ADR 002: Runtime Renderer Over Astro Content Collections For User Docs

Status: Accepted for initial planning  
Date: 2026-05-10

## Context

VegaStack Pages needs to let users and agents create, edit, autosave, comment on, and share Markdown, MDX, and HTML documents at runtime. Canonical source is stored in R2/S3. Private content is permission-checked per request.

Astro content collections are excellent for build-time content and provide typed metadata, render helpers, heading extraction, and MDX support for local files. However, the local Astro 6.3 docs state that live content collections fetch runtime data but do not support runtime MDX rendering.

## Decision

Use Astro content collections for:

- Built-in static app docs.
- Seed docs.
- Developer docs.
- Any content that ships with the application and is known at build time.

Use a VegaStack Pages runtime renderer package for:

- User-created R2/S3 Markdown pages.
- User-created R2/S3 MDX pages.
- User-created R2/S3 HTML pages.
- Runtime frontmatter extraction.
- Runtime heading extraction.
- Runtime sanitization.
- Comment anchor mapping.
- Render cache generation.
- Permission-aware rendering.

## Rationale

Runtime user documents need:

- Immediate rendering after autosave.
- Permission checks on every request.
- Comment anchors tied to changing source.
- Render cache invalidation by source hash.
- MDX safety policy control.
- HTML sandbox behavior.
- Storage outside the app bundle.

Astro content collections do not fit the runtime user-document lifecycle. Forcing user docs into build-time collections would require rebuilds and would not satisfy the review workflow.

## Consequences

Positive:

- User edits render immediately.
- R2/S3 remains canonical.
- Security policy is centralized in `packages/renderer`.
- The app can run on Cloudflare and Node with the same renderer.

Negative:

- More renderer code must be owned by VegaStack Pages.
- Need explicit tests for Markdown, MDX, HTML, sanitization, headings, frontmatter, and code blocks.
- Some Astro MDX conveniences are not directly available for runtime user docs.

Mitigation:

- Use proven unified/remark/rehype packages.
- Keep Astro content collections for static app docs where they are strongest.
- Keep MDX source-first and allow only registered safe components in v1.
- Add render cache and renderer policy versioning.
