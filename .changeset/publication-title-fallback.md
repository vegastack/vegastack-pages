---
"@vegastack/pages": patch
---

`/p/{slug}` publication renders now read the page title from the
row's `title` field (the single source of truth set on create and
displayed in the sidebar) instead of treating the markdown
frontmatter `title` as primary. Agent-created pages without a YAML
`---\ntitle: …\n---` block were rendering "Untitled" in the
breadcrumb and document `<title>` even though the row title was set
correctly and the sidebar showed it. Frontmatter `title` stays as a
fallback for legacy pages that only had it set there.
