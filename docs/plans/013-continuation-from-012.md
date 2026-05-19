# Plan 013 — Continuation from Plan 012 (session 1)

**Status:** Draft. Captures state at the close of Plan 012 session 1.
**Predecessor:** [Plan 012](./012-production-readiness-final.md)
**Drafted:** 2026-05-18

## 1. What landed in Plan 012 session 1

### Phases completed

- **Phase A — Schema finalization.** Verified `packages/db/migrations/0001_init.sql` has no remaining legacy elements (`runtime_state`, `runtime_locks`, `pages.render_cache_key`, `comment_anchors.reanchor_status`, `jobs` table). The changeset description's claim that these still existed was outdated.
- **Phase E — Save-time render pipeline.** `packages/renderer/src/index.ts` extended with `remark-math` + `rehype-katex`; new `renderAtSave({source, sourceType})` wrapper returns `{html, hasCode, hasMermaid, hasMath, hasWardley, hasCytoscape, hasIframe, frontmatter, headings, plainText}`. Handles `markdown`, `mdx` (via markdown pipeline; safe-mdx promotion deferred), `html` (rehype-parse + sanitize). Mermaid preservation continues via `rehypeMermaidBlocks` for client-side render. Deps installed.
- **Phase F — Publish fan-out.** Added `publishFanOut` to `packages/services/src/publications.service.ts`. Wired into `pages.service.ts.updateSource`: after R2 source write + D1 row update, renders → stores `rendered-{hash}.html` → updates `rendered_artifact_key` → if a page-level publication exists and is not revoked, fans out to `pub/{id}/{hash}.html` + updates `latest_*` columns. Failures logged but non-fatal. Cache invalidation deferred (Phase G's responsibility — needs `Request` context).
- **Phase H — Image pipeline.** New files:
  - `apps/web/src/scripts/upload-image.ts` — client-side OffscreenCanvas → WebP (Safari fallback to JPEG q=0.85), `compressBeforeUpload(file)` + `uploadCompressedImage(pageId, file, options)`.
  - `apps/web/src/pages/img/[...key].ts` — R2 image proxy with immutable edge cache, ETag-based 304, `attachments/*` prefix-restricted access.
  - **Not done:** wire `uploadCompressedImage` into `apps/web/src/scripts/page-editor-codemirror.ts` drop/paste handler. Editor still uploads raw bytes. Server route already exists at `apps/web/src/pages/api/pages/[pageId]/attachments.ts` and accepts the body — it just needs to read `X-Image-Width`/`X-Image-Height` headers from the new client and persist to the `image_width` / `image_height` columns.
- **Phase J — AWS SES.** `apps/web/src/lib/email.ts` was already production-ready: manual SigV4 SendRawEmail (no `aws4fetch` dep), Cloudflare `send_email` binding fallback, console dev fallback, `VPG_EMAIL_PROVIDER=auto` selection. Phase J is a no-op.

### Phase B — Partial route migration

Four parallel agents migrated 30+ API routes off legacy `runtime.ts` singletons (`pageService`, `workspaceService`, `commentService`, `favoriteService`, `authService`, `templateService`, `attachmentService`, `permissionService`, `publicationService`, `auditService`, `reviewEventService`, `checkRateLimit`, `ensureSeedData`) to the new `@vegastack/pages-services` namespaces (`pages`, `workspaces`, `comments`, `favorites`, `auth`, `templates`, `attachments`, `permissions`, `publications`, `audit`, `reviewEvents`, `rateLimit`, `search`, `mcpSessions`, `setup`, `users`).

Files migrated (verified by typecheck pass):

- `apps/web/src/pages/api/auth/*.ts` (5 files) — dev-login, logout, signup, magic-link/request, magic-link/verify
- `apps/web/src/pages/api/setup/*.ts` (2) — status, complete
- `apps/web/src/pages/api/audit-logs/index.ts`
- `apps/web/src/pages/api/review-events.ts`
- `apps/web/src/pages/api/search.ts` (partial — see signature gap §3)
- `apps/web/src/pages/api/validate-source.ts`
- `apps/web/src/pages/api/mcp/sessions.ts` (partial — see signature gap §3)
- `apps/web/src/pages/api/comment-threads/[threadId]/*.ts` (6 files)
- `apps/web/src/pages/api/publications/[publicationId]/*.ts` (3 files)
- `apps/web/src/pages/api/templates/[templateId]*.ts` (2 files)
- `apps/web/src/pages/oauth/*.ts` (3 files) — authorize, consent, device/verify
- `apps/web/src/pages/api/integrations/github/*.ts` (2)
- `apps/web/src/pages/api/workspaces/[workspaceId]/github-backup*.ts` (2)

The 4th agent (workspace + folder + page routes batch — ~20 files) and the 5th agent (mcp.ts) were still in flight at session close. Their results need to be checked separately.

## 2. What still needs doing

### Phase B — Remaining migrations

#### Files agents did not finish

The biggest pending batch is the 4th agent's target (assignment was `apps/web/src/pages/api/workspaces/**` and `apps/web/src/pages/api/pages/**` — likely partial). Confirm by grep:

```sh
grep -rln "from \"\.\\./\\.\\./\\.\\./lib/runtime\"" apps/web/src/pages/api 2>/dev/null
```

Files still using legacy at session close (verify via grep):

- All `apps/web/src/pages/api/workspaces/[workspaceId]/*.ts` except the github-backup ones
- All `apps/web/src/pages/api/pages/[pageId]/*.ts`
- All `apps/web/src/pages/api/folders/[folderId]/*.ts`
- `apps/web/src/pages/mcp.ts` (~2,644 LOC) — agent was running at close
- All `apps/web/src/pages/app/*.astro` (settings pages, setup, index)
- `apps/web/src/pages/f/[slugId].astro` and `apps/web/src/pages/p/[slugId].astro` (Phase G handles these — defer)

#### Foundation lib files (not migrated by any agent — deferred)

These were intentionally kept on legacy for the migration window:

- `apps/web/src/lib/access.ts` (616 LOC) — `getApiRequestActor`, `getRequestActor`, `resolvePageAccess`, `resolveFolderAccess`, `resolveActorPermission`, `resolvePublicationForPage` all use `authService`, `workspaceService`, `permissionService`, `publicationService`, `getMcpSession`, `touchMcpSession` from `runtime.ts`. Conversion requires:
  - `getApiRequestActor` → `await auth.getSession(ctx, sessionId)` + `await users.getById(ctx, userId)` for sessions; `await mcpSessions.findByRefreshToken` for bearer auth
  - `resolveActorPermission` → take `member` as input (pre-resolved) and call `permissions.resolve(ctx, ...)`
  - `resolvePublicationForPage` → walk folders via `folders.ancestorPath(ctx, ...)` then `publications.findForResource(ctx, ...)` for each ancestor
  - All callers (every route + every `.astro` page) must `await` these new async paths
- `apps/web/src/lib/workspace-navigation.ts` (208 LOC) — `buildWorkspaceNavigation(actor, workspaceId)` synchronously reads `pageService.listPages` + `workspaceService.listFolders` + `favoriteService.listForWorkspace`. Convert to async D1 queries; callers must `await`. Also used by `service-context.ts.computeTreeVersion` and several astro pages.
- `apps/web/src/lib/settings-data.ts` (140 LOC) — similar story
- `apps/web/src/lib/github-backup.ts` (1,295 LOC) — uses 4 legacy services; also calls `acquireRuntimeMutationLock` + `persistRuntimeState`. Large rewrite.
- `apps/web/src/lib/dev-auth.ts` — keep or delete (only used for `getRequestActor` dev fallback)

#### Signature gaps in the new D1 services that block clean migration

Surfaced by the agents. These are real production gaps the new services should fill:

1. **`audit.list`** — legacy supports `{workspaceId?, afterId?, limit?}` for instance-admin cross-workspace listing + cursor pagination; new requires `workspaceId` and has no `afterId`. **Action:** add `afterId?: string` to `ListAuditLogsInput`; make `workspaceId` optional for instance admins.
2. **`reviewEvents.list`** — same shape change as audit. **Action:** add `afterId?`.
3. **`search.query`** — returns a leaner shape than legacy `searchIndexedResources` (legacy includes `icon`, `matchedField`, `subtitle`, `snippet` with highlight markup). UI consumers depend on the rich shape. **Action:** either enrich the new return type OR add a separate `searchUiResults` helper that wraps `search.query` and adds the rendering metadata.
4. **`search.index(ctx, doc)`** — requires the full SearchDocument shape; not a drop-in replacement for the legacy `scheduleIndexPage(pageId)` background helper. **Action:** add `search.scheduleIndexPage(ctx, pageId)` and `search.scheduleIndexCommentThread(ctx, threadId)` to `search.service.ts` that build the doc and INSERT-OR-REPLACE.
5. **`permissions.assert(ctx, input)`** — signature is `AssertInput = ResolveInput & {required}`. Legacy was `permissionService.assert({actual, required})` (pure check from a pre-resolved level). **Action:** add an overload `permissions.assert(ctx, {actual, required})` that just asserts without re-resolving.
6. **`rateLimit.check(ctx, …)`** — returns `{ok, remaining, resetAt}`; never throws. Every route must do `if (!result.ok) throw new AppError("RATE_LIMITED", …, 429)`. **Action:** add `rateLimit.enforce(ctx, …)` that wraps check + throw.
7. **`auth.createMagicLink`** — caller must pre-hash the token. Legacy returned `{link, rawToken}`. **Action:** add `auth.requestMagicLink(ctx, {email, redirectTo, expiresInSec?})` that handles token gen + hash internally.
8. **`auth.consumeMagicLink`** — returns the magic-link record only; caller must look up user + create session. **Action:** add `auth.verifyMagicLink(ctx, {tokenHash})` that returns `{user, session, redirectTo}` in one call.
9. **`workspaces.create`** — requires explicit `slug`. **Action:** make `slug` optional; default to `slugifyTitle(name)` if absent. Detect collisions via `await workspaces.getBySlug(ctx, slug)` + suffix.
10. **`users.upsert`** — does not change role on existing rows. **Action:** add `users.setRole(ctx, {userId, role})` (already exists) and call it explicitly in `/api/setup/complete` for promotion.
11. **`templates.update`** — drops `slug`, `properties`, and the auto-version semantics. **Action:** add `slug?` and `properties?` to UpdateTemplateInput.
12. **`templates.render(ctx, ...)`** — returns `{title, body, sourceType}` only; legacy combined frontmatter + properties into the source. **Action:** add an option `includePropertiesAsFrontmatter: boolean` (default true) to preserve legacy behavior.
13. **`comments`** — has no `getThreadById`. **Action:** add `comments.getThread(ctx, {threadId})` that returns `CommentThreadRecord`.
14. **`publications.verifyPassword`** — returns `boolean` (not the record). **Action:** keep as-is; callers fetch separately.
15. **`mcpSessions`** — bearer-token id derivation is gone. The new service splits agent_sessions and mcp_sessions. Bearer→session lookup needs a new helper: `mcpSessions.findByBearerToken(ctx, bearer)` that does the hash + lookup.

### Phase C — `runtime.ts` shrink

Blocked on Phase B completion. Currently 2,900 LOC. Target ≤200 LOC.

Delete sections per Plan 011 §4 once no consumer imports them:

- `RuntimeSnapshot` + helpers
- `hydrateRuntimeState`, `hydrateNormalizedRuntimeState`, `ensureRuntimeReady`, `refreshRuntimeState`, `rebuildSearchIndexFromRuntime`
- `acquireRuntimeMutationLock`, `persistRuntimeState`, `persistNormalizedRuntimeState{,Batch}`, `deleteNormalizedRuntimeState`
- `hydrateNodeState`, `persistNodeState`
- All service singletons
- `CREATE TABLE IF NOT EXISTS` bootstrap
- `normalizeCommentAnchorRecord`
- `legacyMcpSessionListId`, `maskListedMcpSession`, `resolveStoredMcpSessionId`
- `fallbackMcpSessions`, `fallbackRefreshIndex`
- `pruneExpiredVersions` (move to cron)
- `ensureSeedData`
- `renderCachedMarkdown` + `apps/web/src/lib/render-cache.ts`

Then delete:

- `apps/web/src/lib/runtime/repos/` (whole dir)
- `apps/web/src/lib/middleware-policy.ts`
- `apps/web/src/pages/api/pages/[pageId]/rendered.ts`
- `packages/core/src/{page-service,workspaces,comments,auth,publications,access-control,attachments,favorites,audit,review-events,search,template-service,rate-limit,setup,events}.ts`

### Phase D — Middleware shrink

Blocked on Phase C. Target ~40 LOC of logic. Pattern from Plan 011 §4 + Plan 012 §5.

### Phase G — Public read path rewrite

`apps/web/src/pages/p/[slugId].astro` and `apps/web/src/pages/f/[slugId].astro`:

1. `caches.default.match` fast path → return cached
2. One D1 SELECT: slug → page (via `pages.getBySlugId`) → publication (via `publications.findForResource` + folder ancestor walk for inherited publications)
3. Password gating via `publications.verifyPassword`
4. ETag = `W/"${latestContentHash}.${Date.parse(latestRenderedAt).toString(36)}"`; If-None-Match → 304
5. R2 `objectStore.get(publication.latestArtifactKey)` → 404 + fallback re-render path
6. Comments island only when `permission ∈ {comment, edit}`
7. Cache-Control matrix per Plan 011 §8
8. `caches.default.put(cacheKey, response.clone())` via `ctx.waitUntil`

New helpers in `apps/web/src/lib/publication-cache.ts`:

- `findPublicationForSlug(db, slug)` — 1-query lookup (joins page + publication; handles folder publication inheritance)
- `computeCacheControl(publication)` per the matrix
- `verifyPasswordCookie(cookies, publication)`
- `passwordPromptResponse(astro, publication)`
- `buildShellHTML({artifact, publication, showComments})`
- `republishOnDemand(ctx, publication)` — race recovery

### Phase I — Final cleanup

Verify by grep that the forbidden DoD identifiers are gone. Trivial after Phase C.

### Phase K — Operations verification

- `/api/health` — already exists, verify works
- `/api/ready` — already exists, verify the deep probe (D1 + R2 + optional SES)
- `apps/web/src/worker.ts` — verify cron handler dispatches `"0 3 * * *"` and `"30 3 * * *"` correctly
- `apps/web/src/lib/search-reconciler.ts` — verify implementation re-derives `search_documents` + FTS5

### Phase L — Tests

Target ≥420 tests:

- save-time-render tests (~8 in `packages/renderer/src/__tests__/`)
- publishFanOut tests (~4 in `packages/services/src/__tests__/publications.service.test.ts`)
- public-read-path tests (~6 in `apps/web/src/pages/_tests/`)
- `/img/[...key]` tests (~3)
- pages.updateSource render+fanout integration (~3)

### Phase M — Final audit

Five-agent audit pass + DoD checklist verification + write `docs/operator-runbook.md`.

## 3. Recommended next session

Order of attack for the next session:

1. **Run typecheck + test** to confirm current state still compiles. If broken, audit the in-flight 4th and 5th agent outputs in `apps/web/src/pages/api/{workspaces,pages,folders}` and `apps/web/src/pages/mcp.ts`.
2. **Fill the 15 service API gaps** listed in §2 (about 1 day of focused work).
3. **Migrate `apps/web/src/lib/access.ts`** — the keystone helper. Many routes will need a single-line change after this.
4. **Migrate `apps/web/src/lib/workspace-navigation.ts`** — same pattern.
5. **Migrate `apps/web/src/lib/github-backup.ts`** — heaviest single file; do it last in Phase B.
6. **Migrate `mcp.ts`** — verify the in-flight agent's work or restart.
7. **Phase C** — shrink runtime.ts.
8. **Phase D** — shrink middleware.
9. **Phase G** — public read path.
10. **Phase L** — tests.
11. **Phase M** — audit + runbook.

Estimated effort: ~3 focused multi-hour sessions.

## 4. Verification at end of session 1

```sh
# Schema clean
grep -E "runtime_state|runtime_locks|render_cache_key|reanchor_status" \
  packages/db/migrations/0001_init.sql
# → empty ✅

# Renderer extended
grep -E "renderAtSave|remark-math|rehype-katex" packages/renderer/src/index.ts
# → matches ✅

# publishFanOut wired
grep -E "publishFanOut|rendered_artifact_key" packages/services/src/{pages,publications}.service.ts
# → matches ✅

# Phase H files
ls apps/web/src/pages/img/ apps/web/src/scripts/upload-image.ts
# → present ✅

# Typecheck
pnpm typecheck
# → exit 0 ✅

# Tests
pnpm test
# → 381/407 passing (26 regressions documented in §5)
```

## 5. Test regression root causes (26 failures at session 1 close)

All 26 regressions trace to **two architectural issues** introduced by the partial migration:

### Cause A — Tests seed via legacy services, routes read via D1 (~20 failures)

```ts
// In test:
const session = authService.createSession("usr_x"); // legacy: writes to in-memory Map
// In route:
await auth.destroySession(ctx, sessionId); // new: reads from D1
// Result: session not in D1; destroy is a no-op or throws.
```

**Fix per affected test file**: replace legacy fixture setup with new D1 service calls. The `apps/web/src/pages/api/workspaces/_tests/workspace-routes.test.ts` shows the canonical pattern (lines 71-95 — `createWorkspaceFixture` seeds via `users.upsert`, `workspaces.create`, etc.).

Affected test files:

- `apps/web/src/pages/api/auth/_tests/logout.test.ts`
- `apps/web/src/pages/api/_tests/publication-route.test.ts`
- `apps/web/src/pages/api/mcp/_tests/sessions.test.ts`
- `apps/web/src/pages/api/mcp/_tests/sessions-views.test.ts`
- `apps/web/src/pages/api/pages/_tests/page-body-limits.test.ts`
- `apps/web/src/pages/api/pages/_tests/page-move-route.test.ts`
- `apps/web/src/pages/api/pages/_tests/page-events-route.test.ts`
- `apps/web/src/pages/api/setup/_tests/setup-complete.test.ts`
- `apps/web/src/pages/api/workspaces/_tests/template-route.test.ts`
- `apps/web/src/pages/api/workspaces/_tests/workspace-grants.test.ts`
- `apps/web/src/pages/oauth/_tests/oauth-flow.test.ts`

### Cause B — Service API gaps (~6 failures)

Specific signature mismatches between the new D1 services and what routes need. Each gap is documented in §3 (15 items). The failing tests stress these paths:

- `permissions.assert` overload `{actual, required}` missing → workspace-grants tests
- `audit.list` / `reviewEvents.list` afterId cursor missing → no impact yet, but the legacy callers will need updates when cursors return
- `templates.update` missing slug/properties → template-route test
- `workspaces.create` returns response without `slug` field in expected shape → workspace collection test
- `workspace.get` doesn't return joined page count → workspace settings test

## 6. Recommended order to reach zero-fail green

1. **Fill the 15 service API gaps** (~1 day). This alone resolves Cause B and unblocks lib/access.ts migration.
2. **Migrate lib/access.ts to use D1 services via ctx.** Make every helper async + D1-backed.
3. **Update each of the 11 affected test files** to seed fixtures through the new D1 services (Cause A fix).
4. Run `pnpm test`. Should be ~407+ passing.
5. **Migrate `mcp.ts`** — was reverted at session 1 close because the agent's intermediate output was inconsistent. Restart with a clearer per-method spec.
6. **Migrate `lib/github-backup.ts` + `lib/workspace-navigation.ts` + `lib/settings-data.ts`.**
7. **Phase C**: shrink `runtime.ts` from 2,900 → ~150 LOC.
8. **Phase D**: shrink `middleware.ts` per Plan 011 §4 outline.
9. **Phase G**: rewrite `/p/[slugId].astro` + `/f/[slugId].astro` for explicit `caches.default.match/put` + R2-artifact-first flow. The existing files already have ETag + Cache-Control headers — just need the explicit Cache API integration.
10. **Phase L**: add render-pipeline + publish-fan-out + image-route tests (~20 new tests).
11. **Phase M**: final 5-agent audit + DoD verification + write `docs/operator-runbook.md` for the destructive pre-deploy sequence (DROP TABLE per existing table → wrangler d1 migrations apply --remote).

Estimated remaining effort: **2-3 focused sessions**.

## 7. What WAS already production-ready before session 1 + what session 1 added

| Capability                          | Pre-session state              | Session 1 delta                                 |
| ----------------------------------- | ------------------------------ | ----------------------------------------------- |
| Schema                              | Clean (no legacy items)        | Verified ✓                                      |
| D1-direct services                  | 17 services + 16 tests passing | Untouched (still solid)                         |
| AWS SES + CF fallback               | Production-ready               | Untouched                                       |
| Cron triggers (wrangler)            | Configured                     | Untouched                                       |
| /api/health, /api/ready             | Untracked files exist          | Untouched                                       |
| KV/IMAGES bindings                  | Already removed                | Verified clean ✓                                |
| Save-time render pipeline           | Missing                        | **Added** ✓                                     |
| publishFanOut + render artifact key | Missing                        | **Added** ✓                                     |
| R2 image proxy                      | Missing                        | **Added** ✓                                     |
| Client image compression script     | Missing                        | **Added** ✓                                     |
| 30+ route migrations                | Partial                        | **Advanced** ✓                                  |
| runtime.ts shrink                   | 2,900 LOC                      | Still 2,900 (unblocked work)                    |
| middleware.ts shrink                | 185 LOC + legacy lock loop     | Untouched                                       |
| /p, /f Cache API integration        | Missing                        | Not done (ETag + Cache-Control already present) |
| Test coverage                       | 407/407 passing                | 381/407 (26 regressions doc'd)                  |

## 8. Production-readiness assessment at session 1 close

**Compilable and deployable:** Yes — typecheck and `apps/web` build both exit 0.

**Functionally correct:** ~93% — 26 test regressions trace to test-fixture/service-API gaps that need the work described in §6.

**Performance ready:** Save-time render eliminates request-path rendering for published pages. publishFanOut writes the R2 artifact at save time. The `/p/[slug]` route still needs explicit Cache API integration for sub-20ms cache hits (currently relies on Cloudflare edge cache via Cache-Control headers — slower but functional).

**Legacy purged:** No — runtime.ts still 2,900 LOC, middleware still uses mutation-lock loop, mcp.ts and several lib files still legacy.

**Operator-side pre-deploy:** Not started. Live D1 truncate + KV namespace deletion + R2 prefix purge + SES domain verify all pending. Plan 011 §2 spells out the runbook; `docs/operator-runbook.md` should consolidate it.

End of session 1.
