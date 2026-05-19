# Production-readiness audit — feat/instant-workspace-v1

**Date:** 2026-05-17 (second pass: 2026-05-17 — all HIGH follow-ups + MEDIUM cleanup resolved; third pass: 2026-05-17 — plan 011 services rewrite landed, 17/17 services on direct-D1)
**Branch:** `feat/instant-workspace-v1`
**Scope:** end-to-end reliability, security, consistency, dead-code, completeness audit prior to potential deploy to `pages.vegastack.com`.

## Plan 011 execution snapshot (2026-05-17 session 1)

- **412/412 tests passing** (up from 321 baseline). `pnpm typecheck` clean. `pnpm build` clean.
- **All 17 services in plan §5 are now direct-D1** under `packages/services/src/<name>.service.ts`:
  setup, users, rate-limit, audit, review-events, auth, attachments, permissions, publications, folders, templates, search, mcp-sessions, favorites, comments, workspaces, pages.
- **Schema (0001_init.sql)** now carries the plan §3 additive cols: `pages.has_iframe`, `pages.rendered_artifact_key`, `publications.latest_artifact_key/content_hash/rendered_at`, `attachments.image_width/height`. Legacy cols (`render_cache_key`, `reanchor_status`, `runtime_state` + `runtime_locks` + `jobs` tables) are still present pending the runtime.ts shrink (Phase D3a).
- **Wrangler config:** `images` binding removed; second cron `30 3 * * *` (search reconciler) added.
- **Ops endpoints:** `/api/ready` deep readiness probe added; search-reconciler cron handler wired into `worker.ts`.
- **Route tests** in `apps/web/src/pages/api/*/_tests/` migrated to seed via direct-D1 services. Each test sets `VPG_RUNTIME=node` + a per-test `VPG_STATE_DIR` in `beforeAll` so the runtime hydrates a clean SQLite per file.

**Still open in plan 011:**

- D1 live-infra inventory + cleanup (queued for maintainer — `wrangler d1 list`, KV namespace delete, R2 prefix purge).
- D3a — shrink runtime.ts to <200 LOC (~3,000 LOC of snapshot/persist/mutation-lock machinery still in place because the legacy service singletons are still consumed by some routes).
- D3b — shrink middleware.ts (blocked on D3a).
- D9 — save-time rendering pipeline (mermaid + linkedom + Shiki — bundle-size measurement required before adding deps).
- D10 — publish fan-out + `/p/[slug]` + `/f/[slug]` rewrite to R2-artifact + Cache API.
- D11 — image pipeline (client-side compression, `/img/[...key]` route, `<Image />` sweep).
- D12 — final 5-agent audit + browser smoke checklist.

## How this audit ran

Five parallel deep-audit subagents (reliability/concurrency, security, consistency, dead-code/legacy, completeness) reviewed the actual code under `apps/web/src`, `packages/*`, `cli/vegastack-pages`, and config files. Each agent classified findings BLOCKER / HIGH / MEDIUM / LOW with file:line evidence. This document is the synthesised punch list plus the record of what was fixed and what remains.

The branch state at audit time: 264 source files in `apps/web/src`, 54 in `packages/*/src`, 63 API routes, 23 Astro pages, 55 components, 49 test files. Build was clean. 316 tests passing.

---

## BLOCKER findings (fixed during audit)

### B-1. Magic-link verify POST deadlocks for 35 seconds, then 503s

**Where:** `apps/web/src/pages/api/auth/magic-link/verify.ts:30`

**What was wrong:** The POST handler called `acquireRuntimeMutationLock()` inside its body. The middleware (`apps/web/src/middleware.ts:158`) had already taken the same lock for the request because POST is in `mutatingMethods`. The lock is not re-entrant (each call uses a fresh `crypto.randomUUID()` owner against a single `runtime_locks` row keyed `"mutation"`), so the inner call spin-waited 75 ms at a time until the 35-second timeout, then threw `LOCK_TIMEOUT`. Every browser magic-link verify POST would deterministically return 503 after a long hang.

**Why missed:** The GET handler (clicked from the email) legitimately needs to acquire the lock because middleware doesn't lock GETs. POST and GET both delegated to a shared helper that unconditionally acquired.

**Fix applied:** Split lock ownership by HTTP method. The shared helper no longer acquires; the GET handler owns the lock and persist, the POST handler relies on the middleware. Replaced the inline error handler with `jsonAppError` for consistency.

### B-2. HTML pages had no CSP, no X-Frame-Options, no clickjacking defense

**Where:** `apps/web/src/lib/security-headers.ts:5-7`

**What was wrong:** `contentSecurityPolicyForResponse` returned `null` whenever `content-type` included `text/html`. Result: every Astro-rendered page (app shell, login, signup, setup, settings, OAuth consent, public publications under `/p/*` and `/f/*`, docs) shipped with NO Content-Security-Policy header. Combined with no `X-Frame-Options`, the entire app was framable by arbitrary origins — clickjacking + login-prompt phishing surface. The middleware was correctly invoking the helper; the helper was correctly skipping the work; the unit test (`middleware.test.ts:23`) was codifying this as intended behaviour with a multi-paragraph comment explaining why HTML couldn't have a CSP.

**Why the previous code chose this:** The comment claimed Astro's build-time auto-CSP would block runtime-injected inline scripts/styles. That's true for Astro's `security.csp` build-time hash mode — but it doesn't apply to HTTP-header CSP. The author conflated the two.

**Fix applied:** Rewrote `security-headers.ts` to emit a real CSP for HTML responses with two profiles:

- **App pages** (hydrating routes): `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, etc. `'unsafe-inline'` is required because we use `<script is:inline>` for theme + CSRF + comments-rail width pre-paint. A future hardening step would migrate those to per-request nonces.
- **Public publication pages** (`/p/*`, `/f/*`): tighter — `script-src 'self'` (no `'unsafe-inline'`) since these pages don't hydrate React.
- **Non-HTML responses** (JSON/API/MCP): kept the previous strict CSP.

Also added `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin` in middleware as defense-in-depth, and extended Permissions-Policy with `interest-cohort=()`. Updated the unit test to assert the new correct behavior + added a new test asserting the stricter public-publication profile.

---

## HIGH findings (fixed during audit)

### H-1. OAuth authorization-code race could mint two tokens from one code

**Where:** `apps/web/src/lib/oauth/codes.ts:164-193`

**What was wrong:** `consumeAuthCode` did `SELECT … WHERE code_hash=?` then JS-checked `status==='pending'` then `UPDATE … WHERE status='pending'`. Two concurrent `/oauth/token` requests with the same auth code BOTH read the pending row, BOTH ran UPDATE (one no-op'd by the WHERE clause), but BOTH returned the same row content to the caller. Both callers minted access tokens.

**Fix applied:** Collapsed to a single atomic `UPDATE oauth_grants SET status='consumed' WHERE code_hash=? AND kind='auth_code' AND status='pending' AND expires_at > ? RETURNING …`. Only one concurrent caller gets RETURNING rows; the other gets an empty result and exits with null.

### H-2. Node-adapter code shipped into the Cloudflare Worker bundle

**Where:** `apps/web/src/lib/runtime.ts:56-63` (static import block).

**What was wrong:** `runtime.ts` statically imported `FileObjectStore`, `createNodeSqliteD1`, `readNodeStateFile`, `writeNodeStateFile` from `apps/web/src/adapters/node/`. Even though the runtime symbols were only invoked behind `isNodeRuntime()` guards, the static imports made the bundler include the adapter module in every output — verified by grepping the Cloudflare worker chunk for `node:fs`/`node:path`/`better-sqlite3` references.

**Fix applied:** Split into a type-only import (erased at runtime) plus a memoised `loadNodeAdapter()` helper that dynamic-imports the adapter via a string specifier. Updated all four call sites in `runtime.ts` to await the dynamic import. Cloudflare bundle no longer carries node-only code.

### H-3. `.changeset/config.json` missing `@vegastack/pages-services`

**Where:** `.changeset/config.json:11-22` (`fixed` group).

**What was wrong:** The `fixed` group lists every workspace package so the changeset tool syncs versions on release. `@vegastack/pages-services` was added during the rebuild but never registered. Next version bump would leave services on the old version while everything else moved.

**Fix applied:** Added `"@vegastack/pages-services"` to the fixed group.

### H-4. Personal dev tunnel hardcoded in `astro.config.mjs`

**Where:** `apps/web/astro.config.mjs:40` and `:125`.

**What was wrong:** `https://pages-mk.vegastack.dev` appeared as a literal in the `allowedDomains` list and `vite.server.allowedHosts`. A developer-specific tunnel domain bleeding into production config.

**Fix applied:** Replaced with `VPG_TUNNEL_URL` env reads — operators set the env var, no developer hostnames in the source tree.

### H-5. Missing `/api/health` liveness probe

**Where:** none (file did not exist).

**What was wrong:** Production uptime probes (Cloudflare Health Checks at the load balancer, UptimeRobot, internal monitoring) need a cheap public endpoint returning 200 with a small JSON body. `/api/local/status` was dev-only.

**Fix applied:** Added `apps/web/src/pages/api/health.ts` returning `{ ok, runtime, build, time }` with `cache-control: no-store`. Does not touch D1 or R2 — pure liveness, not readiness.

### H-6. Missing `public/robots.txt`

**Where:** none (file did not exist).

**What was wrong:** Production needs an explicit robots policy: indexable marketing + docs + public publications, blocked app surface + APIs + protocol endpoints.

**Fix applied:** Wrote `apps/web/public/robots.txt` with `Allow: /`, `/docs/`, `/p/`, `/f/` and `Disallow: /app/`, `/api/`, `/auth/`, `/oauth/`, `/mcp`, `/.well-known/`, plus the protocol-root OAuth shims. Sitemap pointer included.

### H-7. Missing custom 404 page

**Where:** none (file did not exist).

**What was wrong:** Astro 6 with `output: "server"` returns a generic plaintext 404. `/p/[slugId].astro:50` returned `new Response("Page not found", { status: 404 })` — bare text, no brand.

**Fix applied:** Wrote `apps/web/src/pages/404.astro` rendered through `AppLayout` with navigation actions to the workspace, homepage, and docs. Sets `Astro.response.status = 404`.

### H-8. OAuth protocol-shim re-export files missing `prerender` flag

**Where:**

- `apps/web/src/pages/register.ts`
- `apps/web/src/pages/.well-known/oauth-authorization-server/[...slug].ts`
- `apps/web/src/pages/.well-known/oauth-protected-resource/[...slug].ts`

**What was wrong:** Each file re-exports `OPTIONS/POST/GET` from a sibling route. Astro 6 does not inherit `prerender` through re-exports — each route file must declare it. Without it, Astro defaults to whatever `output:` says, which could be wrong for protocol endpoints.

**Fix applied:** Added `export const prerender = false;` to all three files.

### H-9. Unused npm dependencies (`codemirror`, `tslib`)

**Where:** `apps/web/package.json:50,60`.

**What was wrong:** `codemirror` was declared but the granular `@codemirror/*` packages are what the editor actually imports. `tslib` had zero importers and no `importHelpers: true` in any tsconfig.

**Fix applied:** Removed both from `apps/web/package.json` and ran `pnpm install`. -2 packages.

### H-10. Inaccurate `.changeset/clean-slate-rebuild.md`

**Where:** `.changeset/clean-slate-rebuild.md` (full file).

**What was wrong:** The changeset entry claimed "Switched magic-link delivery to Resend HTTPS API and dropped the unused `send_email` and `SESSION` KV bindings" — both claims false. The code uses AWS SES + Cloudflare `send_email`, and `wrangler.jsonc` declares the `send_email` binding.

**Fix applied:** Rewrote the changeset to accurately summarise the diff: SES primary + Cloudflare `send_email` fallback, AsyncLocalStorage fix, atomic OAuth code consumption, real CSP, magic-link deadlock fix, dropped deps, added health/robots/404, adapter split via dynamic imports.

---

## HIGH follow-up findings — RESOLVED on 2026-05-17

The eight items the first audit pass had recorded for a follow-up batch are all addressed in this pass.

### F-1. `consumeMagicLink` race-window tightened ✓

**Where:** `packages/core/src/auth.ts`

**Fix applied:** Re-checked `consumedAt` immediately before flipping it (synchronous, no `await` between check and write — V8 single-threaded guarantees no interleaving inside an isolate). Added the canonical D1-atomic UPDATE-RETURNING pattern in a code comment as the long-term migration target once the in-memory map is replaced. Cross-isolate atomicity still relies on the middleware mutation lock, which is documented.

### F-2. `rotateMcpSessionTokens` wrapped in `d1Batch` ✓

**Where:** `apps/web/src/lib/runtime.ts:rotateMcpSessionTokens`

**Fix applied:** All three UPDATEs (mcp_sessions id rotation, agent_sessions id rotation, mcp_sessions agent_session_id back-link) now commit together inside `d1Batch(async () => { … })`.

### F-3. `revokeMcpSession` + `removeSearchResource` wrapped in `d1Batch` ✓

**Where:** `apps/web/src/lib/runtime.ts`

**Fix applied:** Both functions' multi-DELETE sequences are atomic now. Search-document FTS5 row and base row are removed together; mcp_sessions + agent_sessions removed together.

### F-4. Search-index background tasks: synchronous `waitUntil` registration ✓

**Where:** `apps/web/src/lib/background.ts`, `apps/web/src/worker.ts`

**Fix applied:** Added `setCloudflareWaitUntil()` which the Worker entry calls synchronously on every fetch/scheduled invocation, so the first task in a fresh isolate is captured without racing the dynamic `cloudflare:workers` import. Also added a `pendingTasks` set to hold task promises alive through the import handshake. Background failures now log structured JSON with `event: vpg.background.failed` for observability.

### F-5. `d1Batch` fallback throws on missing transaction primitives ✓

**Where:** `apps/web/src/lib/runtime.ts:d1Batch`

**Fix applied:** When the adapter has neither `.batch()` nor `.exec()`, the function now throws an `INTERNAL_ERROR` AppError instead of silently running statements without a transaction. Production D1 has `.batch`; Node SQLite has `.exec`; any future adapter that lacks both will fail loudly at first use.

### F-6. Setup flow re-checks `setupComplete` immediately before the flip ✓

**Where:** `apps/web/src/pages/api/setup/complete.ts`

**Fix applied:** Added a second `setupService.status().setupComplete` check immediately before `setupService.complete()`. A concurrent setup POST that lost the race now throws `SETUP_ALREADY_COMPLETE` after the first POST flips the flag, instead of duplicating the admin user + workspace creation. Also migrated the route to `jsonAppError` for the error path.

### F-7. Rate limits added to 4 endpoints ✓

- **`/api/workspaces/[wsId]/pages POST`** — 60 pages/user/min (clientRateLimitKey-scoped)
- **`/api/workspaces/[wsId]/invites POST`** — 30 invites/admin/workspace/hour (anti-spam on email blasts)
- **`/api/comment-threads/[tid]/replies POST`** — 20 replies/actor/thread/hour
- **`/api/auth/dev-login`** — 20/email/hour (defense against accidental prod-exposure)

### F-8. OAuth issuer X-Forwarded-Host allowlisted ✓

**Where:** `apps/web/src/lib/oauth/issuer.ts`

**Fix applied:** The forwarded host is now trusted only when it matches the operator's `VPG_BASE_URL` hostname or appears in `VPG_MCP_ALLOWED_HOSTS`. Unknown forwarded hosts are ignored, falling back to `request.url.origin`. Cloudflare's edge already sanitises these headers, but operators behind proxies that don't strip them are now safe from issuer metadata poisoning at `/.well-known/oauth-authorization-server`. Tests updated.

---

## MEDIUM findings — RESOLVED on 2026-05-17

- **Five legacy inline error-response blocks → `jsonAppError`** ✓
  - `workspaces/[workspaceId]/tree.ts` ✓
  - `setup/complete.ts` ✓
  - `auth/dev-login.ts` ✓
  - `auth/magic-link/request.ts` ✓
  - `auth/magic-link/verify.ts` ✓ (during first audit pass)
- **`POST /api/workspaces` now returns `MutationEnvelope`** ✓ — launcher cache invalidates on workspace creation; `tree_version` + `changed_resources: ["workspace:<id>", "members:<id>"]` shipped.
- **`packages/core/src/ids.ts:parsePageSlugId`** ✓ — bare `throw new Error` replaced with `throw new AppError("VALIDATION_ERROR", …, 400)`.
- **Dead exports in `lib/access.ts`** ✓ — `requiredWorkspaceIdFromUrl`, `folderAncestorIdsForPage`, `folderAncestorIdsForFolder`, `publicationAncestorsForFolder`, `resolvePublicationForFolder` dropped from public surface (kept as internal functions).
- **Old session not invalidated on new login** ✓ — defensive `cookies.get("vpg_session")` + `authService.destroySession(previous)` added to `dev-login.ts` and `setup/complete.ts`. Already present in `magic-link/verify.ts`.
- **Cron observability** ✓ — `worker.ts:scheduled` now logs `event: vpg.cron.completed` with `duration_ms` + `synced` + `failed` counters; per-failure `console.error` in `runDueGitHubBackupSyncs` emits structured JSON with workspace + repo + branch context.
- **`app/setup.astro` client-side feedback** ✓ — added `data-setup-form` JS handler with loading/success/error states, fetch-based POST + redirect on success, inline error rendering. Server `<form>` action still works as the progressive-enhancement fallback.
- **`engines.node`** ✓ — added `engines: { node: ">=22.0.0", pnpm: ">=10.0.0" }` to root `package.json`.
- **Templates + attachments service stack deleted** ✓ — `packages/services/src/{templates,attachments}.service.ts`, `packages/services/src/repo/{template,attachment}.repo.ts`, `apps/web/src/lib/runtime/repos/{template,attachment}.in-memory.ts` removed. Type exports + repo-registry entries cleaned up.
- **Old plan + audit docs deleted** ✓ — 9 files (`audit-cycle-3-*.md`, `audit-report-001/002.md`, `implementation-report-007.md`, `plans/007-009`) removed, ~4,000 LOC of stale prose gone.
- **`.env.example` cleanup** ✓ — dropped `VPG_ADAPTER`, `VPG_PUBLIC_URL`, `VPG_LOCAL_ADMIN_NAME`, `VPG_LOCAL_WORKSPACE_NAME`, `VPG_GITHUB_SYNC_CRON`. Added `VPG_TUNNEL_URL` documentation pointer.
- **Comment-panel "swallowed errors"** — re-investigated. The two `} catch {}` blocks in `CommentsPanel.tsx:839, 1901` are DOM-measurement guards (range detachment / coordinate math) with proper null-fallback semantics. Marked as INTENTIONAL, not a swallowed mutation error. No change required.

---

## MEDIUM findings — still tracked as follow-ups (not resolved this pass)

- **Wrangler config drift** between `apps/web/wrangler.jsonc` and `install/cloudflare/wrangler.example.jsonc` — the GitHub-App trio. The example documents it for self-hosters; the canonical omits because the managed deploy uses GitHub-App secrets injected via Worker secrets, not vars. Reconciliation is a doc decision, not a correctness bug. Defer until the install guide is updated.
- **No `sitemap.xml` generation.** `@astrojs/sitemap` not installed. Belongs to a SEO-launch follow-up.
- **`og:image` is the favicon.** Belongs to a design pass on social cards.
- **Service-layer test coverage thin.** Only one envelope test in `packages/services`. Most service-layer exports are exercised only through API-route tests. Adding `*.service.test.ts` files is a tractable separate PR.
- **Magic-link / GitHub-OAuth callback route tests** — not added; current path is `oauth-flow.test.ts` covering the broad shape.

---

## LOW findings (defer indefinitely or cosmetic)

- `apps/web/src/styles/settings.css:42` empty legacy comment placeholder — delete.
- `packages/ui/src/styles.css:351` "Legacy outline aliases resolve to none" — verify if still needed.
- localStorage backfills in `Sidebar.astro`, `UserMenu.tsx`, `SidebarUserPill.tsx`, `ThemeMenu.tsx`, `CommentsSlideOver.tsx`, `AppLayout.astro`, `styles/comments.css` (~60 LOC across 7 files) — kept as one-version-back migration; can be deleted before v1 ship since there are no prior users.
- `apps/web/dist/server/wrangler.json` still references a `SESSION` KV namespace binding that's no longer in source — the build artifact will regenerate on next build; cosmetic.
- Astro renderer test coverage thin.
- `apps/web/src/pages/p/[slugId].astro:50` returns bare-text 404 — superseded now that `404.astro` exists, but the inline path is still reachable; consider redirecting to `/404`.
- Cron handler observability counters discarded.
- No `mergeEnvelopes(a, b)` helper despite manual envelope merging in `comment-threads/[threadId]/complete.ts`.

---

## What changed during the audit (file-by-file)

```
M  .changeset/clean-slate-rebuild.md         rewritten to accurately describe the diff
M  .changeset/config.json                    added @vegastack/pages-services to fixed group
M  apps/web/astro.config.mjs                 dropped personal tunnel literal; VPG_TUNNEL_URL only
M  apps/web/package.json                     dropped unused codemirror + tslib deps
M  apps/web/src/lib/runtime.ts               dynamic-loaded node adapter; type-only static import
M  apps/web/src/lib/security-headers.ts      real HTML CSP (app + strict public publication profiles)
M  apps/web/src/lib/oauth/codes.ts           atomic UPDATE-RETURNING for consumeAuthCode
M  apps/web/src/middleware.ts                X-Frame-Options DENY, COOP same-origin, extended PP
M  apps/web/src/middleware.test.ts           updated CSP assertions to reflect the corrected behavior
M  apps/web/src/pages/api/auth/magic-link/verify.ts   removed re-entrant lock; method-scoped lock+persist
M  apps/web/src/pages/register.ts            prerender=false on protocol shim
M  apps/web/src/pages/.well-known/oauth-authorization-server/[...slug].ts   prerender=false
M  apps/web/src/pages/.well-known/oauth-protected-resource/[...slug].ts     prerender=false
A  apps/web/src/pages/404.astro              custom branded 404
A  apps/web/src/pages/api/health.ts          liveness probe endpoint
A  apps/web/public/robots.txt                production robots policy
A  docs/audits/2026-05-17-production-readiness.md   this file
M  pnpm-lock.yaml                            dropped codemirror + tslib
```

Final verification: `pnpm format` clean. `pnpm typecheck` 0 errors. `pnpm test` 49 files / 317 tests passing. `pnpm --filter @vegastack/pages-web build` clean.

---

## Production-readiness verdict

**Both BLOCKERs are fixed.** The magic-link sign-in path that would deterministically 503 after 35 seconds now works correctly; HTML pages now ship a real CSP plus `X-Frame-Options` so the entire app surface is no longer clickjackable. Eight HIGH issues from the audit were fixed in place (atomic OAuth code consumption, node-adapter bundle leak, changeset config gap, hardcoded personal domain, health endpoint, robots, custom 404, OAuth shim prerender, dropped deps, accurate changeset).

The branch is **shippable to `develop`** as a prerelease after committing the working tree. Eight follow-up HIGH items are documented under "Recorded as follow-up" — none block the deploy, but `runtime.ts` snapshot/lock rewrite + `consumeMagicLink` race tightening should be the next work batch before traffic ramps up.

A `wrangler deploy --dry-run` against the canonical `apps/web/wrangler.jsonc` succeeds; all bindings resolved; the build artifact is 13127 KiB / 2441 KiB gzip across 459 modules. Per the project release gate in `CLAUDE.md`, no actual push, deploy, tag, or publish has been performed.
