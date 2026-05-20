---
"@vegastack/pages": patch
---

Make the page-title row field the single source of truth and extend
MCP session lifetimes.

- **Title duplication fixed.** Templates ship `# {{ title }}` at the
  top of their bodies, the web "new page" dialog seeds the title as a
  leading H1 into the source, and CLI/agent users habitually paste
  the title as their first heading. The persisted source then carried
  the title twice (once on the row, once as the first H1) so every
  rendered surface showed it twice. `pages.create` and
  `pages.updateSource` now strip a leading `# {title}` (markdown/mdx)
  or `<h1>{title}</h1>` (html) that matches the page title on
  persist. Non-matching first headings (`# Introduction`, etc.) are
  left untouched. The strip is exported from `@vegastack/pages-core`
  as `stripLeadingTitleFromSource` and also applied in the unchanged-
  source guard on `PUT /api/pages/:id/source` so the no-op check stays
  consistent.
- **`title` is now required on every create path.** `create_page`
  (MCP), `POST /api/workspaces/:id/pages` (web + CLI), and the
  template-id branch of `create_page` all surface a
  `VALIDATION_ERROR` when the title is missing or blank, instead of
  silently saving the page as "Untitled".
- **MCP refresh token lifetime extended.** Bumped from 60 days to
  180 days, with the access token staying at 1 hour. Aligns with the
  OAuth 2.1 BCP + MCP SEP-2207 guidance on short access tokens +
  long-lived rotated refresh tokens; the longer window compensates
  for known refresh-plumbing bugs in MCP clients (Claude.ai, etc.)
  that occasionally force re-auth even when a valid refresh token
  exists.
- **Personal MCP token default lifetime extended.** Tokens minted
  from Settings → Connections default to 365 days now (was 30) to
  match GitHub PAT / Linear API key / Notion API key conventions.
  OAuth-issued sessions are unaffected — they always specify an
  explicit lifetime.
- **Skill docs + tool descriptions updated** in
  `packages/mcp/src/{index,instructions}.ts` and
  `skills/vegastack-pages/references/{mcp,cli}.md` to spell out the
  title contract: pass it explicitly, do not duplicate it in
  `source`.
