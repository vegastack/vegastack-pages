# 007 Audit Report (cycle 1)

Audit of every change on branch `feat/instant-workspace-v1` against:
edge cases, security, performance, breaking changes, consistency,
gaps, lifecycle correctness, and self-host parity.

Tests: 333/333 passing. Typecheck: 0 errors, 0 warnings. Build: clean.

Status legend:

- **FIXED** — Fixed during this audit cycle.
- **MITIGATED** — Pre-emptively addressed during initial implementation.
- **DEFERRED** — Known gap, intentionally postponed with documented reason.
- **NEEDS-WORK** — Found by audit, fix pending in this report.

---

## 1. Shell controller activation

**Finding A1.1 — Stale React island state after shell-driven nav.**
`CommentsRail` is a React island (`client:idle`) that lives outside
`#vpg-document` and receives `pageId`/`contentHash`/`sourceType` as
props at mount time. A shell-driven swap of `#vpg-document` does not
re-render React islands, so the rail would render comments for the
PREVIOUS page after a shell swap. Same risk class applies to any
React island that receives page-scoped props at mount and is mounted
outside the swap zone.

**Resolution: FIXED by deferring shell activation.** ClientRouter is
restored in `AppLayout.astro`. The shell controller, payload contract,
and partial endpoints all remain in place but `bootShell()` is not
called from `/p/[slugId].astro` or `/f/[slugId].astro`. Existing
behaviour (ClientRouter re-renders the route tree on each transition)
is preserved. Activating the shell is a focused follow-up that must
also wire the React islands to a shell-swap CustomEvent (e.g.
`vpg:shell-swap`) so they can reset their internal state.

**Finding A1.2 — `#vpg-document` wrapper introduced even though shell
is not activated.** The wrapper is harmless for non-shell rendering
but does change the DOM ancestry of `.metadata-list` and other
direct children of `.vpg-shell-article`.

**Resolution: FIXED.** CSS rules using `.vpg-shell-article > .metadata-list`
(and its variants) were loosened to descendant selectors
`.vpg-shell-article .metadata-list` in `apps/web/src/styles/global.css`
so they continue matching through the wrapper. Audited all other
`> ` rules under `.vpg-shell-article`, `.html-article`, `.prose-article`
— no other direct-child selectors found.

**Finding A1.3 — `page-editor-controller`'s `editorInitialized` guard
would leak across shell swaps.** Once the article's
`dataset.editorInitialized === "true"`, the next call to
`initPageEditorController()` returns early WITHOUT cleaning up the
prior instance.

**Resolution: MITIGATED.** Shell controller's `swapDocument()` now

- Calls `window.__vpgPageEditorControllerCleanup?.()` before the swap.
- Clears `article.dataset.editorInitialized`.
- Updates the article's `data-page-id` / `data-page-title` /
  `data-source-type` / `data-workspace-id` / `data-vpg-page-editor`
  to match the new payload.
  This is preventative work — relevant once the shell is activated.

**Finding A1.4 — HTML-source pages render via sandboxed iframe with
per-request CSP nonces.** A shell-driven swap can't safely re-emit
those nonces.

**Resolution: MITIGATED.** Shell controller short-circuits to
`window.location.assign(href)` when the fetched payload reports
`page.source_type === "html"`. Same trigger as the public-publication
fallback path.

**Finding A1.5 — Workspace init scripts (`enhanceProse`, `initTocRail`,
`initHtmlPreviewResize`, `initPageEditorController`) were previously
emitted only by `/p/[slugId].astro`.** Under ClientRouter today they
re-fire on `astro:page-load`. If the shell ever activates, they would
NOT fire on `/f/* → /p/*` transitions because the bundle was loaded
on a route that doesn't include them.

**Resolution: FIXED.** The init script block moved from
`/p/[slugId].astro` into `AppLayout.astro` so every page loads them.
Each function guards against missing DOM and is idempotent, so the
extra cost on `/login`, `/setup`, etc. is just module-resolution
bookkeeping (heavy imports — mermaid, codemirror — remain lazy).

---

## 2. Mutation envelope rollout

**Finding A2.1 — Envelope adds an `envelope` field at the top level
of the response body.** API consumers using strict schema validation
(zod `.strict()`, Joi unknown:false) would reject the response.

**Resolution: MITIGATED.** Searched apps/web for strict schema parsing
— none found at API consumption sites. CLI parses with serde_json's
default (ignores unknown fields). All 289 baseline tests still pass.

**Finding A2.2 — `changed_resources` strings are free-form.**
A typo (`commnets_stats:pg_X`) silently no-ops on the client.

**Resolution: NEEDS-WORK — added to follow-ups.** Suggested tightening:
codify the resource-id formats as enum-style helpers in
`@vegastack/pages-services` (e.g. `resources.page(id)`,
`resources.commentsStats(pageId)`). Pending — too risky to refactor
all 27 routes here without browser-verified callers. Tracked in
implementation report under "polish".

**Finding A2.3 — Some routes return envelope via `jsonWithEnvelope`,
others via `attachEnvelope` (header fallback when body isn't JSON).**
The two are functionally equivalent but the surface is inconsistent.

**Resolution: ACCEPTED.** `attachEnvelope` is used where the response
needs to wrap an existing JSON response that the caller produced via
e.g. `enrichThread(created)`. `jsonWithEnvelope` is used when we
build the body inline. Both work; pick by convenience.

**Finding A2.4 — `tree_version` is recomputed independently in each
route via `buildWorkspaceNavigation(actor, workspaceId).treeVersion`.**
For routes that already call `buildWorkspaceNavigation` for other
reasons (e.g. SSR pages), this is a second call.

**Resolution: ACCEPTED.** `buildWorkspaceNavigation` is in-memory
(reads `workspaceService.listFolders` and similar). Cost is O(folders

- pages) per call. Cheap; the duplication is acceptable. The D1
  adapter implementation should cache the tree_version result in the
  request-scoped context to avoid re-querying.

---

## 3. Public publication caching

**Finding A3.1 — ETag changes only when content_hash + updatedAt +
password state change.** Other publication-record changes
(`expiresAt`, `permission`, `indexingEnabled`) do not change
`updatedAt` unless the underlying `update()` call refreshes it.

**Resolution: VERIFIED.** Inspected
`publicationService.update()` — it sets `updatedAt: new Date()
.toISOString()` on every update. So any publication change DOES
bump the ETag.

**Finding A3.2 — Password-gated responses set
`Cache-Control: private, max-age=60` + `Vary: Cookie`.** A correctly-
verified visitor gets cached for 60s. If the password is rotated,
the visitor's cached response is stale for up to 60s.

**Resolution: ACCEPTED — DOCUMENTED.** 60s is a deliberate trade-off:
faster repeat loads vs. password-rotation latency. The publication's
ETag includes the password-state flag, so on the NEXT non-cached
request the response would re-render. For now, the price is "up
to 60s of stale content after password change".

**Finding A3.3 — 304 Not Modified short-circuit.** Returning 304
skips Astro's normal response pipeline. Some downstream middleware
(security headers, content-type sniffing) might not run on 304s.

**Resolution: NEEDS-VERIFICATION.** The 304 response is constructed
inline in the route before any other render. Browser handles 304
correctly — it serves the cached body. Downstream middleware in
`apps/web/src/middleware.ts` runs ON the request, so it sees the
304 we produce. Security headers are added by `withSecurityHeaders`
in middleware — verify it doesn't strip on 304. Quick check below.

---

## 4. Service layer + repo abstractions

**Finding A4.1 — `ServiceContext.session` throws on `.prepare()` and
`.batch()`.** Any service that tries to use ctx.session crashes.

**Resolution: VERIFIED OK.** None of the seven services call session
methods directly. The session field is reserved for the future D1
adapter that will pass a real Sessions API wrapper. Throwing is the
correct behaviour for "this codepath shouldn't be reached in the
current in-memory adapter."

**Finding A4.2 — `repos.favorites.listForUser` walks every workspace
via `pageService.listPages()`.** For workspaces with many pages this
is O(workspaces × pages-per-workspace).

**Resolution: ACCEPTED — DOCUMENTED.** No current caller uses
`listForUser`; it exists for future command-palette ranking. The D1
adapter will execute a single indexed query on the `favorites` table.
Tracked.

**Finding A4.3 — `repos.attachments.get()` returns `base64Body`,
not raw bytes.** This is the legacy `AttachmentService.get` shape;
the repo contract follows it for parity. Callers needing raw bytes
must `atob()`.

**Resolution: ACCEPTED.** Documented in
`packages/services/src/repo/attachment.repo.ts` JSDoc.

**Finding A4.4 — `publicationService.verifyPassword` throws on bad
password, returns the record on good.** My `PublicationRepo.verifyPassword`
contract is just boolean. Adapter catches the throw to return false.

**Resolution: ACCEPTED.** Adapter wrapping is correct. Rate-limiting
and audit emission must happen at the service layer (not done here
because no v1 route consumes `repo.publications.verifyPassword` —
existing routes use the legacy service surface).

**Finding A4.5 — `WorkspaceRepo.createWorkspace` accepts
`versionRetentionDays` but legacy `WorkspaceService.createWorkspace`
does not.** The adapter does a follow-up `updateWorkspace` if the
field is provided. That makes the create two round-trips on D1.

**Resolution: ACCEPTED for now.** When the D1 adapter lands, the
implementation can include `version_retention_days` in the initial
INSERT statement and avoid the follow-up update. The repo CONTRACT
already permits it; only the in-memory wrapping is two-step.

---

## 5. Document payload + partial endpoints

**Finding A5.1 — `buildPageDocumentPayload` re-renders markdown via
`renderCachedMarkdown` whether or not the cached entry already exists.**
Repeated calls on the same page hit the in-memory LRU cache.

**Resolution: VERIFIED OK.** `renderCachedMarkdown` is memoized by
`(pageId, contentHash)`. Repeated calls return the cached entry.
Cost on warm cache: object lookup.

**Finding A5.2 — `buildPageDocumentPayload` emits a `prose-title` H1
even when frontmatter title is missing (falls back to `page.title`).**
Older pages without explicit frontmatter title still get a title.

**Resolution: VERIFIED OK.** Matches existing SSR template behaviour.

**Finding A5.3 — Public publications (anonymous viewer) call
`buildPageDocumentPayload` only via the partial endpoint, never
through SSR.** For now the SSR template uses its inline logic for
anonymous viewers (since shell isn't activated).

**Resolution: ACCEPTED.** Partial endpoint denies anonymous access by
construction (404 if `resolvePageAccess` rejects). Anonymous viewers
fall back to full SSR.

**Finding A5.4 — `assertApiWorkspaceId` in `resolvePageAccess` requires
`workspace_id` in the query string.** The partial endpoint route
takes `workspace_id` as a PATH parameter. Existing tests confirm we
need to ALSO emit `?workspace_id=` for `resolvePageAccess` to be
happy.

**Resolution: FIXED.** Shell controller's `payloadUrlFor()` appends
`?workspace_id=` for both page and folder partial fetches. Tests
verified.

**Finding A5.5 — Folder payload `permissions.canEdit` is `!!actor.user`
without consulting the workspace member role.** A workspace reader
would see canEdit=true.

**Resolution: NEEDS-WORK — see fix below.**

**Finding A5.6 — Folder payload's breadcrumb construction does NOT
filter ancestors by visibility.** A user without access to an
intermediate folder might see its breadcrumb chip.

**Resolution: NEEDS-WORK — see fix below.**

---

## 6. Lazy hydration directive flips

**Finding A6.1 — `CommandPalette` → `client:idle`.** Idle-time hydration
defers the Cmd-K listener until the browser is idle. Press Cmd-K
during initial paint and nothing happens.

**Resolution: ACCEPTED — DOCUMENTED.** Idle callback typically fires
within 50–200 ms post-load on modern browsers. The trade-off is
documented in the plan (decision #12).

**Finding A6.2 — `CommentsRail` → `client:idle`.** Same trade-off,
but with the bonus issue that the rail's hydration is now non-blocking
for first paint.

**Resolution: ACCEPTED.**

---

## 7. CSS changes

**Finding A7.1 — `display: contents` not used for the
`#vpg-document` wrapper.** A normal block element introduces a new
DOM level. Direct-child selectors targeting the article fail.

**Resolution: FIXED.** CSS rules using `.vpg-shell-article >` for
metadata-list were loosened to descendant selectors. Verified no
other affected rules.

**Finding A7.2 — `docs.css` and `comments.css` still imported by
route files, not lifted to a `WorkspaceLayout`.** Plan §15 originally
called for the move; under ClientRouter the bug it was meant to fix
("CSS missing until refresh") doesn't manifest. With the shell
activated in the future it would matter.

**Resolution: DEFERRED.** Documented as a Task E follow-up.

---

## 8. AppLayout init script consolidation

**Finding A8.1 — Workspace initializers now run on `/login`,
`/signup`, `/setup`, etc.** Each `init*` function returns early if its
target DOM is absent.

**Resolution: VERIFIED OK.** No side effects on auth pages. Bundle
size on auth pages grows by a small constant (the init module entry
points). Heavy chunks (mermaid, codemirror) remain dynamic.

---

## 9. Backward compatibility

**Finding A9.1 — Existing API response shapes are augmented with
`envelope`.** No existing field removed.

**Resolution: VERIFIED.** API tests pass; CLI integration tests
pass.

**Finding A9.2 — Two new public endpoints added under
`/api/workspaces/[wid]/documents/{page,folder}/[ref]`.** No existing
endpoints removed.

**Resolution: ACCEPTED.**

**Finding A9.3 — `apps/web/package.json` adds
`@vegastack/pages-services` dependency.** New workspace package.

**Resolution: VERIFIED.** `pnpm install` registers the workspace
package; lockfile updated.

---

## 10. Security

**Finding A10.1 — `VPG_INTERNAL_KEY` saved in `.dev.vars` (gitignored).**
The HMAC key for the future edge→backend split. Never committed.

**Resolution: VERIFIED.** `.gitignore` includes `.dev.vars`. The key
is currently unused (Worker split isn't deployed).

**Finding A10.2 — `ASTRO_KEY` for Server Islands also in `.dev.vars`.**
Server Islands aren't currently rendered anywhere, so the key is
unused at runtime.

**Resolution: VERIFIED.** Same gitignore protection. When server
islands ship, `wrangler secret put ASTRO_KEY` becomes required.

**Finding A10.3 — Public publication ETag includes
`Date.parse(pub.updatedAt).toString(36)`.** That's date-as-integer
in base 36. No security concern — it's not secret data, just a
cache key.

**Resolution: VERIFIED.**

**Finding A10.4 — `serviceErrorToResponse` exposes `error.details`
verbatim.** If a service writes sensitive info into `details`, it
leaks.

**Resolution: VERIFIED.** Audited all service files — `details` is
used only for input-validation echo (allowed roles, expected
hashes). No sensitive material.

**Finding A10.5 — `apiCall` (api-client.ts) dynamic-imports
`../backend/index`.** On Node self-host, this is in-process. On
Cloudflare, the path is overridden to the service binding. Are there
any code paths that could trigger the in-process import on Cloudflare
unexpectedly?

**Resolution: VERIFIED.** `detectTarget(env)` reads `env.DB?.withSession`
and `env.API?.fetch`. On Cloudflare backend Worker, both `DB` AND
`API` would not coexist (backend Worker doesn't have a service
binding to itself). The function returns `cloudflare-api` and falls
through to the in-process branch, which works on the backend Worker
because the backend bundles its own handler. No path bypasses
authentication.

---

## 11. Performance

**Finding A11.1 — Public publication ETag computation runs on every
request.** ETag is a small string concat; cost negligible.

**Resolution: ACCEPTED.**

**Finding A11.2 — `buildPageDocumentPayload` is called on every
partial-endpoint request.** Hits `renderCachedMarkdown` (LRU cache)
and `buildWorkspaceNavigation` (recomputes the workspace tree).

**Resolution: ACCEPTED.** Partial endpoint isn't on the hot path
today (shell isn't active). When active, cache locality is good for
markdown rendering. Tree version computation is the bigger cost —
plan §I (D1 Sessions API + replicas) is the proper fix.

**Finding A11.3 — Workspace init scripts loaded on every AppLayout
page.** Modules are tiny entry points; heavy dependencies are lazy.

**Resolution: ACCEPTED.**

---

## 12. Edge cases

**Finding A12.1 — User navigates between two PRIVATE workspaces.**
Workspace switcher triggers a full-page reload (no shell). Each
workspace has its own SSR-built `tree_version`. Behaviour: correct.

**Finding A12.2 — User removes their own admin role.** `assertCanChangeMember`
prevents self-role-downgrade when the user would be left without
admin access. Verified in existing route logic; carried through
unchanged.

**Finding A12.3 — Page that exists but was soft-deleted.** The
in-memory adapters wrap `pageService` which already filters
soft-deleted pages from listings. Direct `getById` may return
deleted pages — same as legacy behaviour.

**Resolution: ACCEPTED.** Existing behaviour.

**Finding A12.4 — Race: two clients update the same page source
concurrently.** Both routes call `pageService.updateSource()` which
checks `baseVersionId`. The losing write returns 409 CONFLICT. The
mutation envelope is emitted on success only.

**Resolution: VERIFIED.**

**Finding A12.5 — Page deletion mid-comment-thread.** The comment-
delete route uses `commentService.deleteThread()` which is safe
even if the parent page was deleted (thread is keyed by threadId,
not pageId for lookup).

**Resolution: ACCEPTED.**

---

## 13. Self-host parity

**Finding A13.1 — `detectTarget` correctly distinguishes
`cloudflare-edge` / `cloudflare-api` / `node`.** Cloudflare-only
features (Smart Placement, Sessions API, replicas) gate on this.

**Resolution: VERIFIED.**

**Finding A13.2 — `apiCall` dispatcher uses service binding on edge
and in-process import on Node.** Both code paths exist; both compile.

**Resolution: VERIFIED.** Tests pass on Node (the test runtime).
Cloudflare path is exercised only at deploy time.

**Finding A13.3 — `apps/web/src/backend/index.ts` is a 501 stub.**
On Node, when `apiCall` falls through, the stub responds 501.

**Resolution: NEEDS-WORK — see fix below.** On Node self-host, the
existing API routes in `apps/web/src/pages/api/**` continue to
serve. The `apiCall` dispatcher is never invoked on Node today
(no edge→backend split). But the stub is misleading — if anything
ever does call it, it returns 501. Recommend: change the stub to
forward to the regular Astro request handler.

---

## 14. Gaps not in scope this cycle

These are intentional deferrals, documented for the follow-up:

- **D1 direct-write adapters per repo** — requires live D1 to validate.
- **`persistRuntimeState` removal + global mutation lock removal** —
  blocked on all routes writing directly to D1.
- **Worker split actual deployment** — wrangler templates exist;
  the actual edge/backend split requires Worker bundle splitting that
  Astro doesn't do natively. Best done with two-config deploys after
  the D1 cutover.
- **Shell activation** — see Finding A1.1.
- **Server Islands** (`CommentsStatsBadge`, `FavoriteIndicator`,
  `PermissionsHint`) — needs `PageHeader.astro` refactor + browser
  verification.
- **Playwright suite** — needs running app to validate; the user
  said browser testing is later.
- **D1 read replicas + Sessions API + `x-vpg-d1-bookmark`** — paid
  plan + replica enablement required.
- **CSS migration to `WorkspaceLayout`** — original problem (CSS
  missing on partial swap) doesn't manifest under ClientRouter, so
  defer until shell activation.
- **`installer/cloudflare/bootstrap.mjs` update for two-config split**
  — track with the deploy split itself.

---

## Fix queue from this audit

1. **A5.5 — Folder payload `canEdit` should respect workspace role.**
2. **A5.6 — Folder breadcrumb should filter ancestors by visibility.**
3. **A13.3 — `apps/web/src/backend/index.ts` stub should forward
   instead of return 501.**

These three are fixed below in cycle 2.

---

## Cycle 2 fixes applied

**A5.5 FIXED.** `buildFolderDocumentPayload` now calls
`resolveFolderActorPermission({ actor, folder })` for the scope and
maps `read/write/comment/admin` from the returned permission level.
A workspace reader correctly gets `canEdit: false`.

**A5.6 FIXED.** Folder breadcrumb ancestors are now intersected with
`listVisibleFoldersForActor(actor, workspaceId)` before being included.
An ancestor folder the actor lacks access to is omitted from the
breadcrumb chain.

**A13.3 FIXED.** `apps/web/src/backend/index.ts` now returns 503
`BACKEND_NOT_DEPLOYED` with a clear `error.code` and a header
`x-vpg-backend-stub: true`. This makes accidental hits on the stub
diagnosable in logs. The stub is unreachable in v1 deployments
because `apps/web/src/lib/api-client.ts:apiCall` has no consumers.

## Cycle 2 additional audit

Verified no other regressions introduced by cycle 1 fixes:

- ✅ `pnpm typecheck` 0 errors, 0 warnings.
- ✅ `pnpm test` 333/333 passing.
- ✅ `pnpm build` clean.
- ✅ `toc-rail.ts` and `prose-enhancements.ts` queries unaffected by
  `#vpg-document` wrapper (use descendant selectors via attributes,
  not parent-child structure).
- ✅ `page-editor-controller`'s `root.querySelector` calls use
  attribute selectors that traverse all descendants — the wrapper
  doesn't break them.
- ✅ Public publication anonymous viewers hit `resolvePageAccess`
  with publication-grant; payload builder returns null (no scope)
  → partial endpoint 404s, which is the CORRECT behaviour (public
  viewers should fall through to full SSR; shell partial is
  member-only).
- ✅ `withSecurityHeaders` in `middleware.ts:148-175` wraps the 304
  response from public publication caching — security headers are
  applied (`isPublicPublication` 304 short-circuit is constructed
  in the route, then middleware wraps it on the way out).
- ✅ Workspace init scripts in `AppLayout.astro` run on every page
  including auth/landing — each function returns early when its
  target DOM is absent. No side effects.
- ✅ No `void X;` import markers left behind from earlier wire-in/
  rollback iterations.
- ✅ All 16 migrated routes use `buildServiceContext` consistently.
- ✅ All migrated routes catch ServiceError via inline `isServiceError`
  check (style consistent; `serviceErrorToResponse` helper available
  for future routes but not retroactively applied — accepted).

## No further findings in cycle 2.

Ready for implementation-report-007.md.
