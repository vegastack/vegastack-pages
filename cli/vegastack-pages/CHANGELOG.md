# @vegastack/pages

## 0.2.0-next.14

### Minor Changes

- Workspace + per-user datetime preferences, page-header Move/Trash,
  inline page-title editing, trash UI polish, datetime sweep across
  every timestamp surface.

  **Datetime preferences (new feature)**
  - Two new schema columns (`workspaces.preferences_json`,
    `users.preferences_json`) via migration `0004_datetime_preferences.sql` —
    additive ALTER with `NOT NULL DEFAULT '{}'` so existing rows stay
    well-formed.
  - Pure `formatDateTime()` + `formatAbsolute()` + `readDateTimePrefs()` +
    `mergeDateTimePrefs()` in `@vegastack/pages-core`, with an LRU cache
    on `Intl.DateTimeFormat` instances (limit 64) so dozens of
    timestamps per page cost ~10 ns/lookup instead of ~5 ms/construct.
    14 unit tests cover invalid-blob handling, merge fallthrough,
    absolute + relative + date-only rendering.
  - `PATCH /api/workspaces/:id/preferences` (admin) + `PATCH
/api/me/preferences` (signed-in user). Partial-merge into the
    JSON blob, validated against the typed shape — invalid keys
    return `VALIDATION_ERROR`.
  - `DateTimePreferencesCard` on Settings → General (workspace
    default, admin-only edit) and Settings → Profile (per-user
    override, always editable for the signed-in user). Uses the same
    `.settings-card` / `.settings-card-form` / `.vpg-field` /
    `.vpg-input` / `.vpg-button vpg-button-primary` shell as Version
    retention + Backup to Git — no bespoke styling. Live preview
    block updates as the admin changes any knob. The card sits
    immediately below Version retention in the General page reading
    order.
  - Three knobs (per the feature interview):
    - `dateFormat`: 5 named presets, default `MMM D, YYYY`.
    - `timeFormat`: 12h or 24h, default 24h.
    - `showRelativeWithinDays`: 7-day relative window toggle.
  - Backend stays UTC ISO; the client-side
    `apps/web/src/scripts/time-format.ts` walks every `<time datetime>`
    on page-load + after each Astro view-transition and rewrites the
    visible text in the viewer's browser timezone using the effective
    prefs from `<meta name="vpg-datetime-prefs">`. MutationObserver
    catches React-injected nodes; a 60s ticker keeps relative
    entries fresh; a `vpg:time-refresh` event lets surfaces request
    an immediate re-walk when they mutate a `<time>` element in place.

  **Datetime sweep — every timestamp surface conforms**
  - `<time datetime>` wrappers added: audit log, profile Created,
    connections session list (3 cols), workspace connections log
    cards (3 dl rows), attachments, DocsLayout "Last updated",
    PageHeader "Edited X ago", CommentsPanel reply timestamps,
    /p/ Created at / Updated at metadata.
  - `CommentsPanel` bespoke relative-time helpers replaced with
    central `formatDateTime` / `formatAbsolute` (was duplicating
    locale logic).
  - PageHeader's hand-rolled `relativeEdit` JS dropped; the central
    rewriter handles the label, refresh-on-save just updates the
    `datetime` attribute + dispatches `vpg:time-refresh`.

  **Page-header kebab — Move + Trash**
  - `PageActionsMenu` (the top-right `…` next to Share / Favorite)
    gains `Move page` and `Move to trash` items for editors. Same
    modal + undo-toast flow as the sidebar kebab.
  - Folder list threaded from `PageHeader.astro` → page-actions
    controller → `PageActionsMenu` via a JSON data attribute so the
    Move dialog renders without a separate fetch.
  - Cross-page undo handoff: when the user trashes the page they're
    currently viewing, the toast intent persists in `sessionStorage`
    and re-fires on the destination workspace page so the 10-second
    undo window survives the hard navigation.

  **Inline page title editing**
  - The `<h1>` on `/p/{slug}` is now `contenteditable="plaintext-only"`
    for users with edit permission. Click to edit, Enter / blur
    commits, Esc cancels. Optimistic UI — title updates locally
    first; server save runs in background; on failure the original
    text is restored and an error toast surfaces.
  - New slug is written back via `history.replaceState` so
    deep-links update without a full navigation. Other surfaces
    resync via a fresh `vpg:page-title-changed` custom event.

  **Trash UI polish**
  - `/app/trash` moved out of SettingsLayout. Now lives in the
    workspace AppLayout shell so the regular workspace sidebar
    (pages tree) stays visible — it's a peer of workspace pages,
    not an admin nook. Page header reuses `.settings-pageheader`
    styling for visual consistency, without the eyebrow.
  - Move + Trash kebab items render with default menu-item styling
    (no red text / no red hover background). "Move to…" relabeled
    "Move page". Aligns with the rest of the dropdown.
  - `MoveToFolderDialog` + `TrashList` + `PermanentDeleteConfirm`
    rebuilt with Nova UI primitives (`Dialog`, `Input`, `Button` +
    Lucide icons) so they read as siblings of `ShareDialog`.

  **CSP fix — Astro ClientRouter prep iframe**
  - `frame-ancestors` relaxed from `'none'` to `'self'` on HTML
    responses. Astro's view-transition prep step mounts a hidden
    same-origin iframe to hydrate `client:only` islands before the
    swap; the stricter policy was silently aborting that step in
    dev, breaking sidebar URL updates after navigation. `'self'`
    still blocks every third-party embed.

## 0.2.0-next.13

### Minor Changes

- Trash UI surfaces + the schema-migration split that recovered prod.

  **Schema migration (urgent fix).** `pages.deleted_by_user_id` was
  inlined into `0001_init.sql` on next.11. Prod's D1 had been created
  from an older 0001 so the new code's SELECTs failed with
  `no such column` — every authed page rendered as a 500. Fixed by
  moving the column out of 0001 and into a delta migration
  `0003_pages_deleted_by.sql`. Prod was patched in place with a
  manual ALTER on 2026-05-20; fresh self-hosted installs apply the
  delta as part of the migration sweep.

  **Sidebar page-row kebab (`PageRowMenu`).** Each page row in the
  workspace sidebar now exposes a `…` menu on hover/focus with
  "Move to…", "Copy link", and "Move to trash". The kebab is hidden
  for read-only members.

  **Move-to-folder modal (`MoveToFolderDialog`).** Type-ahead search
  over a flattened folder list (paths shown). "/ (root)" is always
  the first row. Calls `POST /api/pages/:id/move` and full-reloads
  to resync the sidebar tree at the new location.

  **Undo toast on soft-delete.** sonner toast with 10-second window;
  clicking Undo calls `POST /api/pages/:id/restore`. If you trash the
  page you're currently on, you're bounced to the workspace root so
  you don't sit on a now-soft-deleted document.

  **Sidebar "Trash" link + `/app/trash` page.** New "Trash" entry in
  the workspace sidebar footer (above Settings). Routes to a
  SettingsLayout-hosted page listing the pages **the current user**
  trashed. Restore per row. Empty state when there's nothing trashed.
  Timestamps render via `toLocaleString()` in the viewer's browser
  timezone.

  **Workspace Settings → Recovery (`/app/settings/recovery`).** All
  soft-deleted pages workspace-wide, with deleted-by user hydration.
  Editors+ can restore; only admins see the "Delete forever" button.
  The SettingsSidebar grows a `Recovery` nav entry for editors+.

  **Permanent-delete type-to-confirm modal.** Shared across the user
  trash + Workspace Recovery surfaces. Users must type the page
  title verbatim to enable the destructive button — matches GitHub's
  repo-delete pattern.

  **Publication route "in trash" banner CSRF fix.** The restore
  button on `/p/{slug}` used a plain `<form method="post">`; the
  middleware CSRF gate would have blocked the POST because HTML
  form submissions don't carry the `x-vpg-csrf-token` header. The
  banner now uses a `data-vpg-trash-restore` button with an inline
  script that calls `window.fetch` — the AppLayout fetch interceptor
  attaches the CSRF header automatically.

  **CSS additions (`shell.css`).** Kebab popover, hover-to-reveal row
  action affordance, modal shell, folder picker tree, button
  variants, danger styling. Defense-in-depth sizing rules co-locate
  with the sidebar styles.

  **Deferred to a follow-up release** (will land in the next
  prerelease):
  - Page-header (top-right) kebab — adding "Move to…" + "Move to
    trash" + "Restore" entries to the existing `PageActionsMenu`.
    Sidebar kebab covers the main use case today.
  - Inline page-title editing (click the page H1 → editable). Hooks
    cleanly into the existing `.prose-title` element + page-editor
    controller; deserves dedicated UX care (slug regeneration,
    optimistic UI, conflict handling).
  - Drag-and-drop sidebar reorder + cross-folder move. Needs the
    `@dnd-kit` wiring and careful hit-target choices (reorder within
    the same folder vs drop-on-folder).
  - Workspace + per-user datetime preferences. The trash list
    already renders timestamps via `toLocaleString()` as a stopgap;
    the full picker needs a schema column (`preferences_json` on
    both `workspaces` and `users`), a `PATCH /api/.../preferences`
    endpoint pair, a `formatDateTime()` helper in
    `@vegastack/pages-core`, two settings UI surfaces, and a tiny
    client script that rewrites every `<time datetime="…">` element
    in the viewer's browser timezone. Backend stays UTC.

## 0.2.0-next.12

### Patch Changes

- Two audit fix-ups on top of the v0.2.0-next.11 trash backend ship:
  - **`pages.hardDelete` drops orphan publications rows.**
    `publications.resource_id` is a plain TEXT column with no FK to
    `pages.id`, so hard-deleting a page would otherwise leave a
    publications row pointing at a missing page. The fix-up also
    collects each publication's `latest_artifact_key` into the same
    R2-cleanup pass we already do for the page source + rendered
    artifact + every page_versions object key.
  - **Cron auto-purge writes an audit row per purged page.** When the
    nightly `0 4 * * *` job hard-deletes a soft-deleted page that
    passed its 30-day TTL, we now emit an `audit_log` entry with
    `action: page.hard_deleted`, `actorUserId: null`, and metadata
    recording `source: cron-auto-purge`, `ttl_days`, the original
    `deleted_at`, and `deleted_by_user_id`. Admins answering "what
    disappeared overnight?" can trace each purge back to both the
    cron and the original trash event.

## 0.2.0-next.11

### Minor Changes

- Page trash + restore backend, with auto-purge cron, MCP/CLI tools,
  and generic 404 for soft-deleted publication URLs. UI surfaces
  (sidebar kebab, undo toast, sidebar Trash link, Workspace Settings
  → Recovery, inline title editing, move-to modal, drag-and-drop)
  are deferred to the follow-up release.
  - **Schema.** `pages.deleted_by_user_id` column (FK → users.id ON
    DELETE SET NULL) so the Workspace Recovery surface can display
    who trashed a given page.
  - **Service layer.** `pages.softDelete` now records the actor id;
    new `pages.hardDelete` drops the D1 row + page_versions cascade
    - R2 source + rendered artifact; new `pages.listTrashed` returns
      trashed pages scoped to "mine" or "workspace"; new
      `pages.listExpiredTrashedIds` powers the auto-purge cron. Both
      `pages.get` and `pages.getBySlugId` now accept
      `{ includeDeleted: true }`.
  - **HTTP API.** `POST /api/pages/:id/trash` (editor+ soft-delete) +
    `DELETE /api/pages/:id/trash` (admin hard-delete); `POST
/api/pages/:id/restore` (editor+); `GET
/api/workspaces/:id/trash?scope=mine|workspace` with deleted-by
    user hydration in the workspace scope.
  - **Publication route.** `/p/{slug}` returns a generic 404 for
    anonymous visitors when the underlying page is soft-deleted (no
    leak that the slug ever existed — matches Google Drive's
    "Sorry, the file you have requested does not exist"). Logged-in
    workspace editors get a friendly "This page is in the trash"
    banner with a one-click Restore button.
  - **Cron.** New `0 4 * * *` daily Worker cron runs
    `runTrashAutoPurge`, hard-deleting pages whose `deleted_at` is
    older than 30 days. Dispatches by cron expression so the existing
    GitHub-backup + search-reconciler jobs aren't disturbed.
  - **MCP tools.** `delete_page` (with `permanent: boolean` flag),
    `restore_page`, `list_trash` (with `scope` filter). Total tool
    surface bumps from 19 → 22. Tool descriptions document the
    semantics explicitly.
  - **CLI.** `vpg pages delete <page> [--permanent]`, `vpg pages
undelete <page>` (avoids name clash with the existing
    `vpg pages restore <page> <version-id>` for version restores),
    `vpg pages trash [--scope mine|workspace]`.
  - **Permissions.** Editors+ can soft-delete and restore; admins
    only can hard-delete (permanent). Mirrors the user choice in the
    feature interview.

  UI deferred to v0.1.15 (or the next prerelease, depending on the
  timing of the next ship). Until then, admins can manage the trash
  from CLI/MCP; users see soft-deleted pages disappear naturally
  from the sidebar and search.

## 0.1.14-next.10

### Patch Changes

- Adopt a clean snake_case frontmatter convention with humanized
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

## 0.1.14-next.9

### Patch Changes

- `/p/{slug}` publication renders now read the page title from the
  row's `title` field (the single source of truth set on create and
  displayed in the sidebar) instead of treating the markdown
  frontmatter `title` as primary. Agent-created pages without a YAML
  `---\ntitle: …\n---` block were rendering "Untitled" in the
  breadcrumb and document `<title>` even though the row title was set
  correctly and the sidebar showed it. Frontmatter `title` stays as a
  fallback for legacy pages that only had it set there.

## 0.1.14-next.8

### Patch Changes

- Make the page-title row field the single source of truth and extend
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

## 0.1.14-next.7

### Patch Changes

- End-to-end edge-case hardening across MCP, CLI, and the settings UI.
  - **Attachment uploads via base64 actually decoded.** Both the MCP
    `upload_attachment` tool and the JSON `POST /api/pages/:id/attachments`
    path (used by `vpg attachments upload`) were storing the _base64
    string_ as the object body — the service layer UTF-8-encoded it as
    bytes, so every non-text attachment downloaded afterwards returned
    the base64 text instead of the original binary. Both paths now
    decode the base64 into raw bytes before storing, and surface a
    `VALIDATION_ERROR` for malformed input.
  - **`update_thread` with `complete: true` requires a body.** Previously
    passing `complete: true` without a body silently dropped the
    closing-reply intent and left the thread open. It now errors with
    `VALIDATION_ERROR`.
  - **`move_page` requires at least one of `title` or `folder_path`.**
    Calling `move_page` with neither was a silent no-op that returned
    success — confusing for agents expecting an error.
  - **Members table action icons render at 16px.** The styling rule lived
    in `docs.css`, which `SettingsLayout` does not import, so the icons
    were falling back to lucide-react's 24px default and dominating the
    row. Icons now ship with explicit `size={16}` props AND a
    defense-in-depth CSS rule moved into `settings.css`.

## 0.1.14-next.6

### Patch Changes

- `create_page` (MCP + CLI) now respects a caller-supplied `source` when
  `template_id` is also passed. Previously the template render
  unconditionally won and the caller's `source` was silently discarded —
  which broke agent workflows where Claude had already drafted prose and
  expected the template to only contribute structure/frontmatter. The new
  precedence: if `source` is a non-empty string, it wins for the body;
  the template_id is then used only to derive `source_type` and to
  validate that the supplied properties match a known schema. Omit
  `source` (or pass an empty string) to get the previous behavior — a
  fresh template render. Tool description and the agent-facing
  instructions in `@vegastack/pages-mcp` are updated to spell out the
  precedence rule explicitly.

## 0.1.14-next.5

### Patch Changes

- Fix MCP tool results to include the full payload as serialized JSON in
  the `TextContent` block, not a one-line summary. Per the MCP spec
  (2025-11-25), tools that populate `structuredContent` SHOULD also
  serialize the JSON into a `TextContent` block for backwards
  compatibility — most clients (Claude.ai, Cursor) read from
  `content[0].text` and ignore `structuredContent` unless the tool
  declares an `outputSchema`. The previous behavior collapsed every
  tool response to a string like `"VegaStack Pages:fetch: ok"`,
  leaving callers with no usable data and breaking template-driven
  workflows ("create a page from a template"). The dead
  `compactToolText` helper is removed.

## 0.1.14-next.4

### Patch Changes

- Unify the HTML Content-Security-Policy profile across the app shell and
  public publication routes (`/p/*`, `/f/*`). Previously, publications
  used a strict `script-src 'self'` while the app shell used
  `script-src 'self' 'unsafe-inline'`. The strict branch was wrong in
  practice: publications still render `AppLayout`, which emits Astro
  view-transition + theme-detect + CSRF-wrapper inline scripts, and a
  ClientRouter navigation from `/p/...` into `/app/*` carries the
  originating document's CSP into the swapped-in DOM — breaking
  dropdowns, the command palette, and settings modals on the destination
  route. Both routes now share the permissive profile and whitelist the
  Cloudflare Web Analytics beacon host (`static.cloudflareinsights.com`)
  on `script-src` + `connect-src`. The signup rate limit also moves from
  1/min to 10/min to match real-world burst behavior during onboarding.

## 0.1.14-next.3

### Patch Changes

- Surface Cloudflare `send_email` binding failures as structured log
  events instead of silently swallowing them. Until now, when SES fell
  back to Cloudflare and Cloudflare also rejected the send (e.g.,
  destination not verified, sender not on the allowlist), the only
  operator-visible signal was a generic 500 from `/api/auth/signup`. Both
  binding code paths now emit `vpg.email.cloudflare.*_failed` events with
  the upstream error message.

## 0.1.14-next.2

### Patch Changes

- Production-readiness follow-ups discovered while validating the
  v0.1.14-next.1 deploy:
  - **Signup + login form hardening.** Both `/app/signup` and `/app/login`
    forms now declare `method="post"`, an explicit `action` pointing at
    the real API endpoint, and an inline `onsubmit="event.preventDefault()"`.
    Pre-hydration the browser no longer falls through to the default GET
    submission that leaked form fields into the URL query string.
  - **`vpg signup` rate limit relaxed** to 1 request per 60s per email
    (was 4 per 30 minutes). Sane for legitimate retry-after-typo, still
    tight enough to deter abuse.
  - **Email sender pinned to `pages@vegastack.com`** in `wrangler.jsonc`
    (both `VPG_EMAIL_FROM` and the `send_email` binding allowlist) and the
    generated `worker-configuration.d.ts`. Matches the live dashboard
    override and keeps source in sync with prod.
  - **Customer-facing docs cross-links fixed** in `mcp-and-cli.md`,
    `quickstart.md`, and `pages-and-folders.md`. Bare `target.md` relative
    paths were resolving as `/docs/<current>/<target>.md` instead of
    `/docs/<target>`. Switched all 9 links to absolute `/docs/<slug>` form.
  - Operator runbook §1.4 now lists `pages@vegastack.com` as the verified
    sender + the matching `cf-bounce.vegastack.com` DKIM record.

## 0.1.14-next.1

### Patch Changes

- Fix the Cloudflare Worker deploy. The Astro 6 Cloudflare adapter
  auto-provisioned a `SESSION` KV binding by default, which the release
  verifier rejects (the architecture rebuild moved sessions to D1).
  Configure the Astro session driver to the built-in `memory` unstorage
  driver — `Astro.session` is unused, so this is purely a binding-
  suppression switch. Also remove every customer-facing mention of KV
  from the docs and install path; the only remaining references are the
  release verifier itself and the in-code comment explaining the memory
  driver choice.

## Unreleased

### Minor changes

- **Noun-first command tree (pure cutover).** `vpg` reorganized to match `gh` and `wrangler`. Hot-path verbs stay top-level (`login`, `logout`, `whoami`, `use`, `search`, `events`, `validate`, `deploy`, `doctor`, `update`, `completions`). Resource CRUD moves under noun groups: `vpg pages`, `vpg comments`, `vpg publish`, `vpg templates`, `vpg workspaces`, `vpg attachments`, `vpg skills`. Removed: `vpg create`, `vpg comment`, `vpg reply`, `vpg resolve`, `vpg unresolve`, `vpg update-anchor`, `vpg delete-thread`, `vpg complete-thread`, `vpg publish-page`, `vpg publish-folder`, `vpg revoke-publication`, `vpg update-publication`, `vpg pages prepare-edit` (now `vpg pages get --include edit_tokens`), `vpg pages patch` and `vpg pages update-source` (now `vpg pages update`), `vpg pages restore-version` (now `vpg pages restore`).
- **`--agent` on every command.** Compact JSON envelopes on stdout, structured error JSON on stderr (`{ error: { code, message, hint, details } }`), NDJSON for streaming commands. Destructive ops require `--yes` under `--agent`.
- **Exit codes 0–8.** `0` ok, `1` generic, `2` validation, `3` auth, `4` not found, `5` permission, `6` conflict, `7` network, `8` rate limited.
- **`vpg pages update` 3-mode dispatch.** Full source / find-replace / checkpoint-only, with body fields omitted-when-unset.
- **`vpg completions <shell>`.** Generated shell completions for bash, zsh, fish, and PowerShell.
- **Slug resolution everywhere.** `vpg pages get`, `update`, `move`, `restore`, `versions`, `wait`; `vpg comments *`; `vpg publish page`; and `vpg attachments upload` all accept a slug or `pg_…` id.

### Patch changes

- Bearer-authenticated requests are now exempt from CSRF, so `vpg` writes against `/api/*` work cleanly.
- `vpg use` only persists `--base-url` when explicitly passed (no silent overwrite of a stored custom origin).
- `vpg workspaces export` sanitizes the workspace id when interpolating into a default output filename.
- `vpg comments reply` / `complete` omit absent optional fields instead of sending `agent_name: null` (which strict server validators rejected).

## 0.1.13

### Patch Changes

- Consolidate the MCP tool surface around `get_page`, `search_workspace`, `update_thread`, `publication_apply`, `publication_delete`, and `list_workspace`; add consolidated page-ref and review-status APIs for faster CLI/MCP reads; improve authenticated page navigation, comments, share, sidebar, and command palette loading paths; and enable persistent Cloudflare Workers observability logs with request timing diagnostics.

## 0.1.12

### Patch Changes

- Make OAuth device verification redirect unauthenticated users with an absolute login URL so production clients do not receive an invalid relative redirect target.

## 0.1.11

### Patch Changes

- Bypass global runtime middleware for `/mcp` and let runtime-backed MCP calls manage refresh, locking, and persistence inside the MCP handler so Claude connector lifecycle probes return promptly.

## 0.1.10

### Patch Changes

- Fix Claude MCP connector tool refresh by making `/mcp` lightweight for lifecycle probes, returning an SSE-compatible GET stream, and enriching `tools/list` metadata.

## 0.1.9

### Patch Changes

- Fix page creation when D1 search indexing runs before newly created page rows are persisted, and preserve executable permissions on packaged native `vpg` binaries.

## 0.1.8

### Patch Changes

- Default `vpg` managed-hosting commands to `https://pages.vegastack.com`, update MCP discovery to protocol version `2025-11-25`, preserve OAuth login redirect parameters, serve path-derived authorization-server metadata for MCP clients, and improve login, signup, and magic-link status handling.

## 0.1.7

### Patch Changes

- Unblock Claude's OAuth token exchange after consent. The token endpoint now
  accepts the public `client_id` from an empty-secret HTTP Basic header and skips
  the D1 rate-limit write for the well-known Anthropic connector client before
  consuming the short-lived, single-use PKCE authorization code. This keeps the
  broker path inside Claude's timeout while preserving the actual grant checks.

## 0.1.6

### Patch Changes

- Seed the well-known `oac_anthropic_connector` OAuth client in D1 via new
  migration `0021_oauth_well_known_anthropic_connector.sql`. v0.1.3 added the
  runtime fallback that lets `/register` return the pre-baked client_id
  without a D1 write, and v0.1.4 dropped `/register` latency below the
  broker's 1.5s timeout — but when the user clicked **Allow** on the consent
  screen, `/oauth/authorize/consent` tried to `INSERT INTO oauth_grants`
  with `client_id = "oac_anthropic_connector"` and D1 rejected the foreign
  key (the `oauth_grants.client_id REFERENCES oauth_clients(id)` constraint
  fails because no matching row exists). This migration adds the row.

  Same pattern as `0020_oauth_well_known_vpg_cli.sql` for the CLI device-code
  flow client. The runtime fallback in `apps/web/src/lib/oauth/clients.ts`
  stays in place as defense-in-depth for fresh deployments where the
  migration hasn't run yet.

- Disable Astro's pre-middleware `security.checkOrigin` form-origin check so
  standards-compliant OAuth token exchanges from browser MCP brokers can POST
  `application/x-www-form-urlencoded` bodies to `/oauth/token` and `/token`.
  The app-level CSRF middleware remains in force for browser mutations, while
  OAuth/MCP routes keep their deliberate bypass.

## 0.1.4

### Patch Changes

- `/oauth/*` + `/.well-known/oauth-*` now bypass the runtime persistence
  middleware. v0.1.3's Anthropic well-known short-circuit responded in
  single-digit ms inside the handler but the global middleware still ran
  `refreshRuntimeState()` + `persistRuntimeState()` around every POST,
  which adds ~1.4s of wall time per request. claude.ai's connector broker
  times out before that completes. Bypassing for OAuth endpoints — none of
  which need the global persist sweep — drops `/register` end-to-end to
  the handler's own latency.

  Also: simplified `/oauth/register` to call `auditService.record` directly
  (it's a sync in-memory push) instead of wrapping it in a
  `Promise.resolve().then(...)` / `waitUntil()` chain. v0.1.3's version
  was returning 500 from the handler's catch — root cause traced to the
  extra promise dance combined with the middleware lock, both unnecessary.

## 0.1.3

### Patch Changes

- Make `/register` fast enough for claude.ai's connector broker.

  Measured by curl: our DCR endpoint was returning in 1.8-2.4s (two D1 INSERTs
  on the hot path — the client itself + the audit log). claude.ai's broker
  aborts the request at ~1.5s, leaving the connector stuck on "Couldn't reach
  the MCP server" even though everything else was wired correctly.

  Two changes:
  - New well-known OAuth client `oac_anthropic_connector` matching the
    redirect URIs `https://claude.ai/api/mcp/auth_callback` and
    `https://claude.com/api/mcp/auth_callback`. When a `POST /register`
    payload matches that signature, we short-circuit: return the pre-baked
    client_id immediately, no D1 writes, no rate-limit write. Sub-100ms
    response. Same pattern as the existing `oac_vpg_cli` client used by the
    CLI device-code flow.
  - For generic DCR (any other client), the audit-log INSERT is now deferred
    via `ExecutionContext.waitUntil()`. The client INSERT stays synchronous
    (subsequent `/authorize` and `/token` calls have to find the client by
    id), but the audit row writes after the 201 response has been sent.
    Roughly halves response time on the slow path.

## 0.1.2

### Patch Changes

- Serve the OAuth + PRM endpoints at root-level paths so non-spec MCP clients
  can complete the connector add flow.

  Captured via wrangler tail while claude.ai's connector broker probed
  pages.vegastack.com: the broker ignores both the WWW-Authenticate
  `resource_metadata` URL and the `registration_endpoint` value from the AS
  metadata, and instead probes RFC 9728-derived + conventional root paths
  that returned 404. New aliases (re-exports of the existing `/oauth/*`
  handlers, no logic change):
  - `GET  /.well-known/oauth-protected-resource/mcp` (RFC 9728 §3.1 derived
    PRM path)
  - `POST /register` (DCR)
  - `GET  /authorize`
  - `POST /token`
  - `POST /revoke`
  - `POST /device`

  The canonical `/oauth/*` endpoints continue to work for spec-compliant
  clients (including our own `vpg` CLI device-code flow). Authorization-server
  metadata still advertises the `/oauth/*` URLs.

## 0.1.1

### Patch Changes

- Fix claude.ai custom connector discovery and dropdown Log out chrome.
  - `/mcp` now answers `HEAD` with `200` and `MCP-Protocol-Version: 2025-06-18`,
    and serves the same protocol header on `GET 405` and the `401` that
    bootstraps OAuth. claude.ai's connector broker probes with HEAD before it
    follows `WWW-Authenticate`; without it, the Add Custom Connector flow
    silently failed with "Couldn't reach the MCP server" before the OAuth
    consent redirect could open.
  - CORS on `/mcp` exposes `mcp-protocol-version`, `mcp-session-id`, and
    `www-authenticate` so browser-based MCP clients can read them, and the
    `Access-Control-Allow-Methods` list now includes `HEAD`.
  - Reset user-agent button chrome on `.vpg-dropdown-item` so the Log out row
    in the sidebar profile menu no longer paints the macOS `buttonface`
    background full-row. `<a>` and `<button>` rows now render identically at
    rest and on hover.
  - CI fix already on `main`: `release.yml` declares `emailFrom` and gains a
    `publish_npm` skip toggle for emergency deploys without an npm publish.

## 0.1.0

Initial public release of the VegaStack Pages CLI.

### Added

- Native `vpg` launcher distributed through `@vegastack/pages` with platform-specific optional packages.
- Auth and workspace commands for login, logout, identity checks, workspace listing, and workspace selection.
- Page commands for create, get, rendered output, source update, optimistic patch, validate, move, snapshots, version listing, and restore.
- Template commands for list, show, render, create, update, and `vpg create --template` page creation.
- Review commands for listing comments, creating anchored comments, replying, resolving, unresolving, completing, deleting threads, updating anchors, reading events, and waiting on review state.
- Publication commands for public page/folder links, publication updates, revocation, and default comment permission support.
- Workspace utilities for tree, search, export, attachment upload, member invites, setup doctor, deploy bootstrap, and update metadata.
- Portable VegaStack Pages skill commands for path, print, doctor, install, and update so agents can use the same MCP/CLI workflow outside this repo.

### Fixed

- Keep launcher version output aligned with the published package version.
