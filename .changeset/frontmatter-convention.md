---
"@vegastack/pages": patch
---

Adopt a clean snake_case frontmatter convention with humanized
display labels and drop the duplicated/dead defaults.

- New `humanizeFrontmatterKey()` helper in
  `@vegastack/pages-core` converts `snake_case`, `kebab-case`, AND
  `camelCase` keys to sentence-cased labels (`for_audience` →
  "For audience", `lastEditedBy` → "Last edited by"). Short
  ALL-CAPS acronyms (≤4 chars) are preserved (`API_key` → "API
  key"). Used everywhere frontmatter labels are displayed so the
  convention is enforced from one place instead of per-key
  special cases.
- The web "New page" dialog no longer seeds `title:`, `type:`,
  `updated:` into the body's frontmatter. Title lives on the row,
  `type` was never read anywhere, and `updated` is now sourced
  from the row's auto-managed `updated_at`. The seed now contains
  just a placeholder `summary:` field so users/agents have a
  documented field to fill.
- `summary` replaces `description` as the recommended one-line
  description field (still falls back to `description` for legacy
  pages so nothing breaks).
- The publication render synthesizes `Created at` / `Updated at`
  metadata from the page row's `createdAt` / `updatedAt` columns
  and prepends them to the user frontmatter block — system-managed,
  not editable from the YAML, never churns the content hash on save.
- Skill docs and MCP `create_page` description updated to spell
  out: pass `title` (required) + `summary` (optional), do NOT pass
  `created_at` / `updated_at` (auto-managed), and snake_case keys
  display sentence-cased.
- Publication render breadcrumb / document title now reads from
  `page.title` row field directly (was reading `frontmatter.title`
  and falling back to "Untitled" — which is why agent-created
  pages without YAML frontmatter showed "Untitled" in the
  breadcrumb even though the sidebar showed the real title).
