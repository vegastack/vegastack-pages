# 007 Implementation Report

Branch: `feat/instant-workspace-v1`
Plan: `docs/plans/007-instant-workspace-architecture.md`
Audits: `docs/audit-report-001.md`, `docs/audit-cycle-3-findings.md`,
`docs/audit-cycle-3-summary.md`, `docs/audit-cycle-3-verification.md`,
`docs/audit-report-002.md` (cycle 4 — final).

Final verification (post cycle 4):

- `pnpm typecheck` → **0 errors, 0 warnings, 7 hints** across all 11
  workspace packages. The 7 hints are Astro-check false positives for
  imports consumed by top-level `Astro.redirect` calls in three pages
  (`app/login.astro`, `app/signup.astro`, `app/settings/sessions.astro`).
- `pnpm test` → **349/349 passing** (+60 vs. baseline 289 on `main`,
  +13 vs. end of cycle 3).
- `pnpm --filter @vegastack/pages-web build` → completes with no
  `Astro.request.headers` prerender warnings (cycle-3 F-022 fix).

---

## Delivered

### Foundation

- Feature branch `feat/instant-workspace-v1` off `main` (no `develop` branch exists on origin).
- `.dev.vars` (gitignored) holding `ASTRO_KEY` and `VPG_INTERNAL_KEY` for future deploy-time `wrangler secret put`.
- `apps/web/src/lib/runtime/target.ts` — runtime detection (`cloudflare-edge` / `cloudflare-api` / `node`).
- `apps/web/src/lib/api-client.ts` — service-binding-or-in-process dispatcher (no consumers in v1; reserved for future Worker split).
- `apps/web/src/backend/index.ts` — backend Worker entry stub returning `503 BACKEND_NOT_DEPLOYED` until split is wired.
- `install/cloudflare/wrangler.frontend.example.jsonc` + `wrangler.backend.example.jsonc` — split-Worker templates with Smart Placement on backend.

### `@vegastack/pages-services` package

- New workspace package containing:
  - `ServiceContext`, `Actor`, `MutationEnvelope`, `SessionHandle`, `ServiceError` types.
  - `buildEnvelope`, `attachEnvelope`, `jsonWithEnvelope` helpers.
  - Seven repo interfaces (async): `FavoriteRepo`, `PageRepo`, `CommentRepo`, `WorkspaceRepo`, `PublicationRepo`, `TemplateRepo`, `AttachmentRepo`.
  - Seven services: `favorites`, `pages`, `comments`, `workspaces`, `publications`, `templates`, `attachments`. Each pure-function over `ServiceContext`; emits `MutationEnvelope` alongside data.
  - 9 Vitest cases for envelope helpers.

### In-memory repo adapters

- `apps/web/src/lib/runtime/repos/*.in-memory.ts` for all seven repos.
- `apps/web/src/lib/runtime/repos/index.ts` exports the `repos` registry consumed by route handlers.
- `apps/web/src/lib/service-context.ts` — `buildServiceContext({ cookies, request, workspaceId })` factory + `serviceErrorToResponse(error, fallback)` helper.

### Mutation envelope (Workstream G — complete)

27 nav-affecting routes return `{ ..., envelope: { tree_version, content_hash?, navigation_invalidated, changed_resources[] } }`:

- `pages/[pageId]/{source, patch, move, snapshot, versions, comments, favorite, access, attachments, publication}.ts`
- `comment-threads/[threadId]/{index, resolve, unresolve, replies, anchor, complete}.ts`
- `folders/[folderId]/{access, publication, reorder}.ts` + `folders/[folderId].ts`
- `workspaces/[wid]/{pages, folders, templates, settings, invites, leave, github-backup, github-backup/sync, members/[mid]}.ts`
- `publications/[publicationId]/index.ts`
- `templates/[tid].ts` + `templates/[tid]/pages.ts`

Auth, setup, search, validate-source, mcp/sessions, me, and workspaces/index POST intentionally excluded — they don't affect workspace tree state.

### Route migration to services + repos (Workstream A — 45%)

16 nav-affecting routes refactored end-to-end to consume `services.*` via `buildServiceContext`:

| Route                                               | Service method                             |
| --------------------------------------------------- | ------------------------------------------ |
| `/api/pages/[pageId]/favorite.ts` PUT/DELETE        | `services.favorites.add / remove`          |
| `/api/pages/[pageId]/source.ts` PUT                 | `services.pages.updateSource`              |
| `/api/pages/[pageId]/patch.ts` POST                 | `services.pages.updateSource`              |
| `/api/pages/[pageId]/move.ts` POST                  | `services.pages.move`                      |
| `/api/pages/[pageId]/snapshot.ts` POST              | `services.pages.updateSource (checkpoint)` |
| `/api/pages/[pageId]/versions.ts` POST              | `services.pages.restoreVersion`            |
| `/api/pages/[pageId]/comments.ts` POST              | `services.comments.createThread`           |
| `/api/comment-threads/[threadId]/index.ts` DELETE   | `services.comments.deleteThread`           |
| `/api/comment-threads/[threadId]/resolve.ts` POST   | `services.comments.resolve`                |
| `/api/comment-threads/[threadId]/unresolve.ts` POST | `services.comments.unresolve`              |
| `/api/comment-threads/[threadId]/replies.ts` POST   | `services.comments.reply`                  |
| `/api/comment-threads/[threadId]/anchor.ts` PATCH   | `services.comments.updateAnchor`           |
| `/api/comment-threads/[threadId]/complete.ts` POST  | `services.comments.reply + resolve`        |
| `/api/workspaces/[wid]/pages.ts` POST               | `services.pages.create`                    |
| `/api/workspaces/[wid]/folders.ts` POST             | `services.workspaces.createFolder`         |
| `/api/folders/[folderId]/reorder.ts` POST           | `services.workspaces.reorderFolder`        |

### Document payload contract + partial endpoints (Workstream C — infrastructure)

- `apps/web/src/lib/document-payload.ts` — `buildPageDocumentPayload()` and `buildFolderDocumentPayload()` + canonical `DocumentPayload` type.
- `GET /api/workspaces/:wid/documents/page/:ref` — partial endpoint, member-only access, 404 on unknown/cross-workspace.
- `GET /api/workspaces/:wid/documents/folder/:ref` — same shape for folders, breadcrumb filtered by visibility.
- Folder permissions correctly derived from `resolveFolderActorPermission` (not `actor.user`-only as in cycle-1 draft).

### Shell controller (Workstream C — built, NOT activated)

- `apps/web/src/scripts/shell/{index,types}.ts` — link interception, history.pushState, DOM swap, `astro:page-load` re-dispatch, popstate restore, full-page fallback, `x-vpg-d1-bookmark` replay.
- Bug fixes pre-applied for when activation lands: editor-controller cleanup, article `data-*` refresh, HTML-page fallback to full nav.
- **Activation deferred** (`bootShell()` not called from any route) because `CommentsRail` and other React islands outside `#vpg-document` would render stale page-scoped state after a shell swap. ClientRouter is restored in `AppLayout.astro` so today's UX is preserved.

### Public publication caching (Workstream J — complete)

- `Cache-Control: public, max-age=300, s-maxage=31536000, stale-while-revalidate=60` for indexable + non-password-gated.
- `Cache-Control: private, max-age=60` + `Vary: Cookie` for password-gated.
- `Cache-Control: private, no-store` for authenticated workspace views.
- `ETag` includes `content_hash` + `publication.updatedAt` (base36) + password-state flag so any change busts the cache.
- `If-None-Match` short-circuit returns 304 (middleware applies security headers afterwards).

### Lazy hydration (Workstream E — partial)

- `CommandPalette` flipped from `client:load` → `client:idle` in both `/p/[slugId].astro` and `/f/[slugId].astro`.
- `CommentsRail` flipped from `client:load` → `client:idle` in `/p/[slugId].astro`.

CSS migration to a `WorkspaceLayout` deferred — under ClientRouter the original "CSS missing on partial swap" failure mode doesn't manifest.

### Workspace shell DOM (forward-prepared)

- `<div id="vpg-document" data-vpg-document>` wrapper added inside `<article class="vpg-shell-article">` in both `/p/[slugId].astro` and `/f/[slugId].astro` so the shell controller can swap the document body cleanly when activated.
- `<div data-vpg-editor-host>` moved outside the wrapper so it persists across future shell swaps.
- CSS rules using `.vpg-shell-article > .metadata-list` loosened to descendant selectors so they continue matching through the wrapper.
- Workspace init scripts (`enhanceProse`, `initTocRail`, `initHtmlPreviewResize`, `initPageEditorController`) consolidated from `/p/[slugId].astro` into `AppLayout.astro` so they run uniformly on all pages and are correctly re-fired on both ClientRouter and shell-driven nav.

### Self-host parity (Workstream K — 50%)

- `apps/web/src/lib/runtime/target.ts` distinguishes Cloudflare vs Node.
- `apps/web/src/lib/api-client.ts` picks service-binding vs. in-process import based on runtime.
- `apps/web/src/backend/index.ts` stub returns clear 503 with diagnostic header when reached unexpectedly.
- Cloudflare-only optimizations (Smart Placement, D1 Sessions API, replicas) are wired only into the templates, not active in code paths today — they short-circuit gracefully on Node.
- `install/cloudflare/bootstrap.mjs` left unchanged — still generates the unified single-Worker config; updates to emit two configs will land with the actual deploy split.

### Tests (+44)

- `packages/services/src/__tests__/envelope.test.ts` (9)
- `apps/web/src/lib/__tests__/document-payload.test.ts` (6)
- `apps/web/src/lib/__tests__/favorites-service.test.ts` (6)
- `apps/web/src/lib/__tests__/pages-service.test.ts` (7)
- `apps/web/src/lib/__tests__/comments-service.test.ts` (5)
- `apps/web/src/lib/__tests__/workspaces-service.test.ts` (5)
- `apps/web/src/pages/api/_tests/documents-route.test.ts` (6)

---

## Intentional deferrals (NOT shipped in v1)

Every item below has a documented blocker and is not a behavioural regression today.

- **Shell activation.** Code shipped, not invoked. Activation requires wiring React islands (notably `CommentsRail`) to a shell-swap event so they reset page-scoped state. Browser-verified follow-up.
- **D1 direct-write adapters per resource.** Requires live D1 to validate the SQL. Code stubs not added (no dead code rule).
- **`persistRuntimeState` removal + global mutation lock removal.** Blocked on every nav-affecting route writing directly to D1.
- **Worker split actual deployment.** Wrangler templates exist; build pipeline doesn't yet emit two bundles. Best done with the D1 cutover.
- **Server Islands** (`CommentsStatsBadge`, `FavoriteIndicator`, `PermissionsHint`). Need `PageHeader.astro` refactor + browser verification.
- **Playwright suite.** Browser-dependent; deferred per direction.
- **D1 read replicas + Sessions API + `x-vpg-d1-bookmark`.** Requires paid plan + replica enablement.
- **CSS migration to `WorkspaceLayout`.** Original failure mode doesn't manifest under ClientRouter.
- **`installer/cloudflare/bootstrap.mjs` update for split.** Tracks with deploy split.
- **`changed_resources` typed constants** to eliminate typo risk in mutation envelopes (cosmetic; current strings are reviewed).
- **`serviceErrorToResponse` retrofit** to all 16 migrated routes (cosmetic consolidation).

---

## Production readiness statement

Today's deployment surface is unchanged from `main`:

- All existing API consumers (browser, MCP, CLI) see identical response shapes augmented with an additive `envelope` field they may safely ignore.
- Navigation under `/p/*` and `/f/*` still goes through ClientRouter — same UX as today.
- Public publications now ship with proper cache headers (a strict improvement; was missing).
- Backend persistence layer is unchanged on the hot path: `runtime.ts` snapshot + mutation lock still in effect; no behaviour change. The repo abstraction wraps it, so the future cutover to direct-D1 is a swap of `apps/web/src/lib/runtime/repos/index.ts` and nothing else.

What ships as new capability:

- Two partial endpoints (member-only) for the workspace document model.
- 27 route responses now carry a mutation envelope that future clients can use to invalidate caches surgically.
- A typed service surface (`@vegastack/pages-services`) ready for MCP and additional route migrations.

What ships as forward-prepared:

- The shell controller, the document payload contract, the Worker split templates, the runtime detection helper. None of these are active code paths today; all are reviewed, typed, and unit-tested where applicable.

---

## Files added / modified summary

**Added:**

- `docs/plans/007-instant-workspace-architecture.md`
- `docs/audit-report-001.md`
- `docs/implementation-report-007.md` (this file)
- `.dev.vars` (gitignored)
- `packages/services/` — 16 source files + tests
- `apps/web/src/lib/runtime/target.ts`
- `apps/web/src/lib/runtime/repos/` — 8 files (registry + 7 in-memory adapters)
- `apps/web/src/lib/api-client.ts`
- `apps/web/src/lib/service-context.ts`
- `apps/web/src/lib/document-payload.ts`
- `apps/web/src/lib/__tests__/` — 4 test files
- `apps/web/src/scripts/shell/` — 2 files (controller + types)
- `apps/web/src/backend/index.ts`
- `apps/web/src/pages/api/workspaces/[workspaceId]/documents/{page,folder}/[ref].ts`
- `apps/web/src/pages/api/_tests/documents-route.test.ts`
- `install/cloudflare/wrangler.{frontend,backend}.example.jsonc`

**Modified:**

- 27 mutation routes (envelope rollout)
- 16 of those further refactored to use `@vegastack/pages-services`
- `apps/web/src/pages/{p,f}/[slugId].astro` — `#vpg-document` wrapper, hydration directives, public caching headers
- `apps/web/src/layouts/AppLayout.astro` — workspace init script consolidation, ClientRouter retained with documented context
- `apps/web/src/styles/global.css` — direct-child selectors loosened to descendant selectors
- `apps/web/package.json` — adds `@vegastack/pages-services` workspace dep
- `pnpm-lock.yaml` — registers new workspace package

---

## Cycle 4 fixes (post audit-cycle-3)

See `docs/audit-report-002.md` for the full status of all 26 cycle-3
findings. Highlights of cycle 4 changes:

- **Authorization contract** for `@vegastack/pages-services` documented
  in `packages/services/src/index.ts` (F-008).
- **Document-payload builders** now accept and validate `workspaceId`
  (F-007); page-partial endpoint header comments clarified to say
  member-only (F-018).
- **Public-publication cache policy** now distinguishes indexable
  (long shared cache) from link-only (short shared cache) and
  password-gated (private, cookie-vary) for both `/p/*` and `/f/*`
  routes (F-005, with the F-003/F-004 work that landed in cycle 3).
- **Shell controller**: `popstate` now revalidates the cached payload
  against the server in the background and re-swaps on divergence
  (F-010). Pure helpers `shouldHandle` + `payloadUrlFor` are now
  exported and unit-tested (F-019).
- **Envelope helper**: `attachEnvelope` is now strictly JSON-only;
  non-JSON or malformed-JSON responses throw rather than fall back to
  an `x-vpg-envelope` header (F-014). The reply+resolve helper merges
  envelopes correctly when a comment thread is replied-to-and-resolved
  in a single call (F-015).
- **Runtime detection** honors `VPG_RUNTIME` as the authoritative
  discriminator and falls back to binding shape only when absent
  (F-013).
- **Build hygiene**: `AppLayout.astro` no longer reads cookies; every
  caller (8 routes / layouts) passes `initialTheme` via the new
  `readInitialTheme(cookies)` helper. Eliminates the prerender warnings
  (F-022). Removed unused `_CommentAnchorRecord` type alias and the
  deprecated iframe `scrolling="no"` attribute (F-023).
- **Repo hygiene**: `.gitignore` now excludes vendored agent skill
  material under `.agents/skills/*` (except the tracked `ship/`); the
  earlier `skills-lock.json` modification was reverted to HEAD (F-026).
- **Test coverage**: 13 new tests across partial endpoints (anonymous /
  non-member / cross-workspace), the envelope helper's strict-JSON
  contract, the shell controller's URL routing, and pages service's
  CONFLICT-on-stale-baseVersionId.

### Deferred (with rationale)

Three findings are explicitly deferred with rationale documented in
`docs/audit-report-002.md`:

- **F-012**: `apiCall()` 503 stub. No consumers today; revisit when the
  backend Worker handler is wired in workstream B.
- **F-016**: MCP migration to the service layer. Intentionally out of
  scope for this branch; MCP keeps its own permission helpers around
  the legacy runtime services until a deliberate MCP adapter is
  designed.
- **F-017**: Folder payload SSR parity. `bootShell()` is not invoked by
  `AppLayout.astro` in this branch (ClientRouter remained the active
  navigation path); folder shell swaps are gated on either rendering
  the `FolderPageList` component into the payload `document_html` or
  marking folder shell-swaps unsupported. Until activation, every
  `/f/*` navigation goes through SSR and visual fidelity is correct.

The two MEDIUM performance items (F-024 navigation rebuild,
F-025 mutation lock + whole-runtime persistence) are deferred to
workstream A's D1-direct adapter where indexed queries and
per-resource atomic writes can deliver the actual performance win.

---

## Ready to commit + ship

The branch is ready to commit. No `git push`, `wrangler deploy`, `npm publish`, or `gh release` actions have been taken — those wait for your explicit "ship" trigger per CLAUDE.md release gate.

Next concrete steps when you give the word:

1. `git add` the files listed above; commit with the prepared message.
2. (Optional) `wrangler secret put ASTRO_KEY` to the production Cloudflare environment (not required today since Server Islands aren't activated, but it's ready).
3. `wrangler deploy --config install/cloudflare/wrangler.example.jsonc` (still single-Worker; split deploy is a follow-up).
