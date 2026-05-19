# vegastack-pages production-readiness review

## TL;DR — verdict

Verdict: SHIP-AFTER-FIXES
Confidence: medium
Live deployment health: amber
P0 count: 0
P1 count: 9

Do not ship this branch until the P1 findings are closed. Typecheck, unit tests, and the web build pass. CI still fails on `pnpm format`. The highest-risk release blockers are stale public artifacts after page soft-delete, non-atomic page saves, SHA-256 publication passwords, broken compressed-image upload, missing page-body indexing, unbounded workspace reads, and release workflow drift that reintroduces KV.

Production is older than this branch. That is a known condition and is not counted as a codebase defect. Runtime probes still matter: live `/api/health` and `/api/ready` return the old 404 app, the live Worker still binds `SESSION` KV, and production D1 has the pre-rebuild schema.

## Methodology

- Reviewed local branch `feat/instant-workspace-v1` at `8cd94e3 chore(infra): canonical wrangler.jsonc + drop VPG_ADAPTER (plan 010 phase 2)`.
- Ran read-only local gates: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @vegastack/pages-web build`, `pnpm audit --audit-level high`, `pnpm format`, `pnpm --filter @vegastack/pages test`.
- Attempted Rust CLI test with `cargo test --manifest-path cli/vegastack-pages/Cargo.toml`; host lacks `cargo`.
- Used read-only Cloudflare commands/API only. No deploy, rollback, secret mutation, publish, GitHub mutation, or npm mutation.
- Wrote only this report file.

## 1. Build and test integrity

1a. TRUE: `pnpm install` completed. Output:

```text
Scope: all 10 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

Update available! 10.33.2 → 11.1.3.
Done in 667ms using pnpm v10.33.2
```

1a. TRUE: `pnpm typecheck` passed with 0 errors and 3 hints. Verbatim:

```text
apps/web typecheck: Result (259 files):
apps/web typecheck: - 0 errors
apps/web typecheck: - 0 warnings
apps/web typecheck: - 3 hints
```

Warnings/hints to fix before release:

```text
apps/web typecheck: src/pages/api/integrations/github/start.ts:45:11 - warning ts(6133): 'ctx' is declared but its value is never read.
apps/web typecheck: src/pages/app/login.astro:4:1 - warning ts(6133): 'loginRedirectTarget' is declared but its value is never read.
apps/web typecheck: src/pages/app/signup.astro:4:1 - warning ts(6133): 'loginRedirectTarget' is declared but its value is never read.
```

1a. TRUE: `pnpm test` passed. Verbatim:

```text
Test Files 64 passed (64)
Tests 434 passed (434)
Duration 14.19s (transform 5.73s, setup 800ms, import 27.40s, tests 20.79s, environment 10ms)
```

1a. TRUE: `pnpm --filter @vegastack/pages-web build` passed. Verbatim:

```text
> wrangler types && VPG_RUNTIME=cloudflare astro build && pagefind --site dist/client --output-subdir pagefind
wrangler 4.90.0
Types written to worker-configuration.d.ts
13:53:26 [@astrojs/cloudflare] Enabling compile-time image optimization...
13:53:26 [@astrojs/cloudflare] Enabling sessions with Cloudflare KV with the "SESSION" KV binding.
build complete, prerendered docs routes, server built in 20.75s.
Pagefind v1.5.2: Indexed 15 pages, 1140 words, 0 filters, 0 sorts.
```

1b. PARTIAL: default `pnpm test` does not print per-test durations. Re-run with verbose found two tests over 5s:

```text
apps/web/src/pages/oauth/_tests/oauth-flow.test.ts > Device authorization grant > issues a device_code + user_code; approval lets the CLI redeem 6039ms
apps/web/src/pages/oauth/_tests/oauth-flow.test.ts > Device authorization grant > accepts the well-known vpg-cli client_id without registration and returns workspace_id 6013ms
```

1c. PARTIAL: typecheck includes `apps/web/src/**/*` and `packages/*/src/**/*.ts`: `apps/web/tsconfig.json:9` has `include: [".astro/types.d.ts", "src/**/*", "astro.config.mjs"]`; package tsconfigs include `src/**/*.ts`. Test discovery includes only `packages/**/*.test.ts`, `apps/**/*.test.ts`, and `install/**/*.test.ts` at `vitest.config.ts:22-26`. Coverage excludes most release code: `vitest.config.ts:7-13` includes only `packages/config`, `packages/core`, `packages/mcp`, and `packages/renderer`; `apps/web/src`, `packages/services/src`, `packages/db/src`, and `packages/ui/src` are excluded from coverage.

1d. FALSE: CI is stricter and currently fails. `.github/workflows/ci.yml:31-36` runs `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @vegastack/pages test`, and `pnpm build`. Local requested gates did not include `pnpm format`, CLI package test, Rust test, or full workspace build. `pnpm format` failed:

```text
[error] docs/plans/011-fresh-clean-slate.md: SyntaxError: Unexpected token (15:38)
[error] docs/plans/012-production-readiness-final.md: SyntaxError: Invalid character. (16:52)
Error occurred when checking code style in 2 files.
 ELIFECYCLE  Command failed with exit code 2.
```

CLI package test passed:

```text
tests 7
pass 7
fail 0
duration_ms 990.055916
```

Rust CLI test was not run because the host has no `cargo`:

```text
zsh:1: command not found: cargo
```

## 2. Live production deployment

2a. TRUE: Cloudflare account is accessible read-only. `wrangler whoami`:

```text
Logged in as mk@vegastack.com.
Account Name: VegaStack (PeerXP)
Account ID: d8d3a8313371b96024d5fb5f31baf6c9
```

2a. TRUE: latest live deployment is old/unknown-source, not this branch:

```text
Created: 2026-05-15T19:44:42.813Z
Version ID: ec9de04d-fb38-4ead-9fa7-69f9079e529c
Source: Unknown (deployment)
```

2b. TRUE: `wrangler tail --format json` ran for about 30s and produced no log lines before manual stop. No error log, slow request, or PII leak observed in that window.

2c. PARTIAL: production D1 exists and is pre-rebuild. Live tables include `runtime_state`, `runtime_locks`, old migrations, and many old runtime tables. Local `packages/db/migrations/0001_init.sql` does not include `runtime_state` or `runtime_locks`. This drift is expected because the feature branch is not deployed.

2d. FALSE for live production, TRUE for local branch intent. Live account still has KV namespace:

```text
vegastack-pages-sessions-prod f651e62192514a498d94b3f0277e0091
```

Current `apps/web/wrangler.jsonc` has no `kv_namespaces` block, but the release workflow still writes one at `.github/workflows/release.yml:367-372`.

2e. PARTIAL: live Worker settings show R2 binding `CONTENT` to `vegastack-pages-content-prod`. Cloudflare R2 API listed no `attachments/` or `pub/` objects. `wrangler r2 object list` is not available in installed Wrangler 4.90.0:

```text
ERROR Unknown arguments: prefix, remote, list, vegastack-pages-content
```

2f. PARTIAL: live secrets listed:

```text
AWS_ACCESS_KEY_ID
AWS_REGION
AWS_SECRET_ACCESS_KEY
MAGIC_LINK_SECRET
SESSION_SECRET
SETUP_TOKEN_SECRET
VPG_EMAIL_FROM
VPG_EMAIL_FROM_NAME
VPG_EMAIL_PROVIDER
VPG_SETUP_TOKEN
```

Missing for this branch's configured features: `ASTRO_KEY`, `VPG_GITHUB_APP_PRIVATE_KEY`, `VPG_GITHUB_APP_CLIENT_ID`, `VPG_GITHUB_APP_CLIENT_SECRET`. `apps/web/wrangler.jsonc:18-27` names these as required secrets.

2g. PARTIAL: local config registers both crons at `apps/web/wrangler.jsonc:117-119`: `["0 3 * * *", "30 3 * * *"]`. `wrangler triggers list` failed because Wrangler 4.90.0 has no `list` subcommand:

```text
ERROR Unknown argument: list
wrangler triggers
COMMANDS
  wrangler triggers deploy ...
```

2h. FALSE for live production: both endpoints are not deployed yet. `curl -i https://pages.vegastack.com/api/ready` and `/health` returned Astro 404 HTML with `server-timing` around 6.2s. Headers included HSTS, Permissions-Policy, Referrer-Policy, X-Content-Type-Options, X-Frame-Options, but no CSP on the 404 body. Local branch has `/api/health` and `/api/ready`.

2i. TRUE: live well-known OAuth endpoints respond. They match the route family in `apps/web/src/pages/.well-known/` and return issuer/resource metadata with `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=300`.

2j. TRUE: production is older than local branch. Git evidence:

```text
8cd94e3 (HEAD -> feat/instant-workspace-v1) chore(infra): canonical wrangler.jsonc + drop VPG_ADAPTER (plan 010 phase 2)
8fddc96 (tag: v0.1.13, origin/main, origin/HEAD, main) feat: release v0.1.13 performance and MCP consolidation
```

Live deployment date is `2026-05-15T19:44:42.813Z`; local branch HEAD is after `v0.1.13`.

## 3. Astro + Cloudflare Worker fitness

3a. PARTIAL: `apps/web/astro.config.mjs:57-78` sets `output: "server"` and `adapter: cloudflare({ imageService: { build: "compile", runtime: "passthrough" }, platformProxy: { enabled: false } })`. Build output still says:

```text
[@astrojs/cloudflare] Enabling sessions with Cloudflare KV with the "SESSION" KV binding.
```

That conflicts with the project claim "NO KV" unless the release workflow and generated `dist/server/wrangler.json` prove no `SESSION` binding.

3b. TRUE/PARTIAL: `apps/web/src/worker.ts:26-33` wires `fetch` with `ctx.waitUntil`:

```ts
setCloudflareWaitUntil((promise) => ctx.waitUntil(promise));
return handle(request, env, ctx);
```

`apps/web/src/worker.ts:34-109` wires `scheduled()` with `ctx.waitUntil`. However, `apps/web/src/pages/mcp.ts:65-68` has module-level mutable state:

```ts
const activeWaitForReviewCalls = new Set<string>();
```

That violates the stated "NO in-memory singleton state expected in production" rule.

3c. TRUE: every non-test route under `apps/web/src/pages` that should be edge-rendered has `export const prerender = false`; docs routes are explicitly `true`. The only files without `export const prerender` were test files.

3d. PARTIAL: common hot paths can exceed 50 subrequests on large workspaces. `apps/web/src/pages/f/[slugId].astro:232-248` loads every page then runs `Promise.all(allFolderPages.map(...resolveActorPermission...))`. `apps/web/src/pages/api/workspaces/[workspaceId]/attachments.ts:43-55` loads all pages and then calls `attachments.listForPage` per page.

3e. PARTIAL: render-heavy CPU work exists on save. `packages/services/src/pages.service.ts:735-750` calls `renderAtSave` after the D1 source update; render failures are non-fatal. That is expected work, but it is synchronous on the request path until the rendered artifact write completes.

3f. FALSE: unbounded memory growth paths exist. `packages/services/src/pages.service.ts:379-402` returns all pages. `packages/services/src/folders.service.ts:280-292` returns all folders. Public SSR pages call these at `apps/web/src/pages/p/[slugId].astro:238-268` and `apps/web/src/pages/f/[slugId].astro:204-232`.

3g. PARTIAL: bindings are resolved through runtime helpers, but `apps/web/src/lib/runtime.ts` still captures module-level state. Evidence at `apps/web/src/lib/runtime.ts:127-155` includes fallback stores/maps and runtime promises; `apps/web/src/lib/runtime.ts:365-402` stores `runtimeD1`.

## 4. D1 safety + efficiency

4a. TRUE: service package user values are parameterized with `.bind()`. The one SQL identifier interpolation is constrained: `packages/services/src/publications.service.ts:607-610` uses `const table = resourceType === "folder" ? "folders" : "pages";` before `SELECT slug_id FROM ${table} WHERE id = ?1`.

4b. PARTIAL: migration foreign keys mostly have sensible `ON DELETE`: users/auth/workspaces cascade, `pages.folder_id` is `ON DELETE SET NULL`, page_versions/favorites/comments cascade. Publications are polymorphic and `resource_id` has no FK at `packages/db/migrations/0001_init.sql:282-300`; page soft-delete must therefore explicitly revoke publications.

4b. TRUE: unique business constraints exist for users email, workspace slug, workspace members, permissions tuple, folder/page slug IDs, workspace template slug, publication resource tuple, magic-link token hash, refresh-token hash, and user_code.

4b. PARTIAL: NOT NULL and CHECK constraints are present, but `pages.version_id TEXT` is nullable at `packages/db/migrations/0001_init.sql:130` while `updateSource` treats production rows as having a version id and keeps a legacy null path at `packages/services/src/pages.service.ts:656-660`.

4b. PARTIAL: most WHERE/ORDER BY columns have indexes. Missing or weak indexes remain for unbounded scans such as `SELECT id FROM workspaces` in `apps/web/src/lib/search-reconciler.ts:30-34` and `SELECT ... FROM github_sync_connections WHERE enabled = 1 ... ORDER BY updated_at` in `apps/web/src/lib/github-backup.ts:1320-1323`.

4c. FALSE: N+1 exists in workspace attachment listing: `apps/web/src/pages/api/workspaces/[workspaceId]/attachments.ts:43-55` lists all pages then queries attachments per page.

4d. FALSE: queries without `LIMIT` can return >10k rows: `pages.list`, `folders.listAll`, `search.reconcileWorkspace`, `workspaces.listForUser`, `attachments.listForPage`, and GitHub backup due-sync all lack limits.

4e. FALSE: multi-write mutations not wrapped end-to-end in `db.batch()`:

- `packages/services/src/pages.service.ts:616-727`: R2 put, page update, page_versions insert.
- `packages/services/src/pages.service.ts:735-785`: render R2 put, page update, async publication fan-out.
- `packages/services/src/attachments.service.ts:142-172`: R2 put, D1 insert.
- `packages/services/src/attachments.service.ts:258-265`: D1 delete, R2 delete.
- `packages/services/src/templates.service.ts:302-354`: R2 put before D1 batch.
- `packages/services/src/templates.service.ts:437-484`: R2 put before D1 batch.

4f. TRUE: exactly two migration files exist:

```text
packages/db/migrations/0001_init.sql
packages/db/migrations/0002_oauth_seed.sql
```

4f. TRUE: `0001_init.sql` uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. `0002_oauth_seed.sql:12` and `:39` use `INSERT OR IGNORE`.

4f. FALSE for live production: production D1 is not at this state; see §2c.

## 5. R2 object store hygiene

5a. PARTIAL: R2 write paths:

- Page source: `packages/services/src/pages.service.ts:616-619`.
- Rendered page artifact: `packages/services/src/pages.service.ts:741-750`.
- Public artifact: `packages/services/src/publications.service.ts:504-520`.
- Attachments: `packages/services/src/attachments.service.ts:135-144`.
- Templates: `packages/services/src/templates.service.ts:302-306` and `:437-441`.

Matching delete paths are incomplete. Publication revoke deletes the current public artifact best-effort at `packages/services/src/publications.service.ts:350-363`, but page soft-delete bypasses that service at `packages/services/src/pages.service.ts:916-929`. Attachments have a delete path at `packages/services/src/attachments.service.ts:246-265`. Template pruning was not found.

5b. PARTIAL: keys are mostly namespaced. Attachments use `attachments/{workspaceId}/{sha256(body)}.{ext}` at `packages/services/src/attachments.service.ts:8-12`. Two tenants can upload identical bytes and get distinct keys because workspace id is included.

5c. TRUE: public keys use `pub/{publicationId}/{contentHash}.html` at `packages/services/src/publications.service.ts:504-505`. Private source/rendered keys use `pages/{workspaceId}/{pageId}/...`; attachments use `attachments/`.

5d. TRUE: Cloudflare R2 API list for live `pub/` returned no objects. This is consistent with no feature-branch deployment.

5e. FALSE: live R2 lifecycle rules only include Cloudflare's default multipart abort rule. No orphan GC lifecycle rule exists. Code comments rely on one at `packages/services/src/publications.service.ts:359-360`.

## 6. Security

6a. TRUE: session lookup enforces expiry at `packages/services/src/auth.service.ts:178-193`.

6a. TRUE: magic-link consumption is atomic at `packages/services/src/auth.service.ts:292-318`.

6a. TRUE: request and verify rate limits exist. Request: `apps/web/src/pages/api/auth/magic-link/request.ts:29-40`, 5 per 15 minutes per email. Verify: `apps/web/src/pages/api/auth/magic-link/verify.ts:51-60`, 30 per minute per IP.

6a. TRUE: dev-login is gated to dev or local diagnostic node mode at `apps/web/src/pages/api/auth/dev-login.ts:19-37`.

6b. TRUE: MCP bearer token lookup enforces `expires_at` at `packages/services/src/mcp-sessions.service.ts:383-398`.

6b. TRUE: refresh token lookup enforces `refresh_token_expires_at` at `packages/services/src/mcp-sessions.service.ts:407-423`.

6b. TRUE: token rotation is a single `UPDATE ... RETURNING` at `packages/services/src/mcp-sessions.service.ts:445-486`.

6b. TRUE: refresh token client mismatch is rejected at `apps/web/src/pages/oauth/token.ts:300-318`.

6b. TRUE: replay detection uses `previous_refresh_token_hash` at `packages/db/migrations/0001_init.sql:510-526` and revokes on replay at `apps/web/src/pages/oauth/token.ts:279-297`.

6b. TRUE: static MCP bearer tokens are blocked in production unless explicitly allowed at `apps/web/src/pages/mcp.ts:2673-2683`.

6b. PARTIAL: static token comparison uses `constantTimeEqual` at `apps/web/src/pages/mcp.ts:2673`. OAuth refresh token lookup hashes then uses indexed equality; there is no raw secret string compare on the D1 path.

6c. TRUE: browser mutations are gated by same-origin and CSRF at `apps/web/src/middleware.ts:132-148`.

6c. PARTIAL: bypass list includes OAuth/MCP routes at `apps/web/src/lib/middleware-policy.ts:9-24`. `/oauth/authorize/consent` is cookie-authenticated but has an explicit route-local origin check at `apps/web/src/pages/oauth/authorize/consent.ts:15-28` and enforces it at `:54-60`.

6d. TRUE/PARTIAL: CSP is applied in middleware at `apps/web/src/middleware.ts:76-82`. Public publication paths use tight `script-src 'self'` in `apps/web/src/lib/security-headers.ts:28-62`. App shell uses `'unsafe-inline'` for Astro hydration/pre-paint; this is documented in code.

6e. FALSE: publication password hashing is weak. `packages/services/src/publications.service.ts:14-19` says SHA-256 with 16-byte salt and intentionally drops argon2id. The implementation is `sha256Hex(`${saltHex}:${password}`)` at `packages/services/src/publications.service.ts:136-165`.

6e. TRUE: publication password cookie comparison is constant-time at `apps/web/src/lib/publication-cache.ts:109-129`.

6e. PARTIAL: cookie scoping was not fully verified in this pass. The compare path is narrow, but the report should require explicit `Path`, `Secure`, `HttpOnly`, `SameSite`, and `Max-Age` evidence before ship.

6f. TRUE: `/img/[...key]` rejects non-`attachments/`, `..`, and null bytes at `apps/web/src/pages/img/[...key].ts:54-65`.

6f. TRUE: `/oauth/register` caps body at 32 KiB at `apps/web/src/pages/oauth/register.ts:58-84`.

6f. FALSE: file upload allowlist is permissive and no virus/executable detection exists. `packages/services/src/attachments.service.ts:68-83` maps `image/svg+xml`, `text/html`, `application/json`, and other content types; unknown types fall back to filename extension. `/img/[...key]` is public-by-key at `apps/web/src/pages/img/[...key].ts:8-12`.

6g. TRUE: SQL injection review matches §4a.

6h. PARTIAL: secrets are not printed by `wrangler secret list`. Email SES error redaction exists at `apps/web/src/lib/email.ts:237-243`. Ad-hoc `console.error(error)` remains in OAuth register at `apps/web/src/pages/oauth/register.ts:53-55` and `:198-206`.

6i. PARTIAL: renderer uses `rehype-sanitize` at `packages/renderer/src/index.ts:295-371` and `:480`. The custom schema allows global `style` at `:337-339` and `span: ["className", "style"]` at `:369`. No exploit was exercised, but style re-enablement should be narrowed.

6j. TRUE: GitHub backup fetches only fixed GitHub hosts: `apps/web/src/lib/github-backup.ts:150`, `:443`, `:471`. No arbitrary user-controlled fetch URL was found.

6k. FALSE: `pnpm audit --audit-level high` fails:

```text
high | Svelte devalue: DoS via sparse array deserialization
Package devalue
Vulnerable versions >=5.6.3 <=5.8.0
Patched versions >=5.8.1
Paths apps__web>@astrojs/react>devalue
7 vulnerabilities found
Severity: 6 moderate | 1 high
```

## 7. Reliability + data correctness

7a. FALSE: page save is not atomic across R2 + D1. `packages/services/src/pages.service.ts:616-619` writes R2 before `UPDATE pages`; `:707-726` inserts `page_versions` after the page row points at the new `version_id`.

7a. PARTIAL: render-at-save is intentionally non-fatal. `packages/services/src/pages.service.ts:735-797` catches render errors after source persistence and logs `render.atSave.failed`.

7a. TRUE: publish fan-out is moved off the response hot path using `ctx.waitUntil` at `packages/services/src/pages.service.ts:753-785`.

7b. TRUE/PARTIAL: `publishFanOut` rolls back the new public R2 object if the D1 latest update fails at `packages/services/src/publications.service.ts:522-548`. It deletes the previous key best-effort at `:549-564`. Cache purge only happens when `publicOrigin` is supplied at `:571-590`; `pages.service.ts:updateSource` calls `publishFanOut` without `publicOrigin` at `packages/services/src/pages.service.ts:771-776`.

7c. TRUE when `publications.revoke` is used: latest artifact fields are nulled at `packages/services/src/publications.service.ts:335-349`, R2 delete is best-effort at `:350-363`, and API delete invalidates cache at `apps/web/src/lib/publication-api.ts:216-226`.

7d. FALSE: page soft-delete does not call `publications.revoke`. It only sets `revoked_at` at `packages/services/src/pages.service.ts:916-929`, then deletes the page at `:930-935`. It does not null `latest_artifact_key`, delete R2, or purge edge cache.

7e. FALSE: search index drift exists. `packages/services/src/search.service.ts:233-236` reads `source-${row.updated_at}.md`, but page source objects are keyed as `source-${hash}.${ext}` at `packages/services/src/pages.service.ts:185-192`. Reconciler writes `bodyText: ""` at `packages/services/src/search.service.ts:582-598`.

7f. PARTIAL: cron handlers are registered in `apps/web/src/worker.ts:34-109`. GitHub backup handles one workspace failure and continues at `apps/web/src/lib/github-backup.ts:1318-1345`. Search reconciler does not: `apps/web/src/lib/search-reconciler.ts:36-43` loops sequentially and one workspace error stops the job.

7g. PARTIAL: SES SigV4 signing is implemented at `apps/web/src/lib/email.ts:270-350`. No retry, circuit breaker, bounce handling, or suppression handling was found.

7h. PARTIAL: many sensitive events use `audit.record`, but PII can be stored: OAuth DCR records `ua` and `ip` at `apps/web/src/pages/oauth/register.ts:125-132` and `:175-182`. Exportability/scrubbing is not documented.

## 8. Performance

8a. PARTIAL: web build completed and produced a Worker bundle. Heavy module-top-level dependency exists: Shiki highlighter is created at module top level in `packages/renderer/src/index.ts:448-452`, then awaited during render at `:466`. This loads syntax highlighting machinery for render paths.

8b. PARTIAL: `GET /p/{slug}` anonymous fast path is Cache API -> R2 -> response when `latestArtifactKey` exists at `apps/web/src/pages/p/[slugId].astro:54-80` and `apps/web/src/lib/publication-cache.ts:213-315`. Fallback/member path loads folder tree and all workspace pages at `apps/web/src/pages/p/[slugId].astro:238-268`.

8b. PARTIAL: `POST /api/pages/[id]/source` does at least page read, R2 source put, D1 update, version insert, render, R2 rendered put, D1 rendered update, publication lookup, and waitUntil fan-out; see `packages/services/src/pages.service.ts:587-797`.

8b. PARTIAL: `POST /mcp tools/call` caps body at 2 MiB (`apps/web/src/pages/mcp.ts:65-67`) and validates auth at `:2653-2749`, but some tools use workspace-wide services and can inherit unbounded list behavior.

8c. TRUE/PARTIAL: cache matrix is sensible in `apps/web/src/lib/publication-cache.ts:27-43`: password-gated private, indexable public long `s-maxage`, link-only short shared cache. ETag includes content hash, publication updatedAt, and password state at `:49-56`. Vary is set for password cookie at `:31-33` and `:289`.

8d. FALSE: list endpoints lack limit/cursor. Examples: `packages/services/src/pages.service.ts:379-402`, `packages/services/src/folders.service.ts:280-292`, `packages/services/src/attachments.service.ts:230-243`, `apps/web/src/pages/api/workspaces/[workspaceId]/tree.ts:56-85`.

8e. N/A: no branch-production D1 exists for this schema; remote `EXPLAIN QUERY PLAN` would inspect the old production schema. Do not use old production query plans to certify this branch.

8f. PARTIAL: client image compression uses OffscreenCanvas and WebP/JPEG fallback at `apps/web/src/scripts/upload-image.ts:77-106`. R2 proxy streams R2 body and uses Cache API at `apps/web/src/pages/img/[...key].ts:82-123`. The upload route contract is broken; see BUG-01.

## 9. Consistency

9a. PARTIAL: naming is mostly consistent. Legacy class names remain in `packages/core/src/*Service` files and tests.

9b. PARTIAL: most API routes use `serviceErrorToResponse`, `jsonAppError`, or route-local OAuth errors. SSR pages hand-roll plain responses: `apps/web/src/pages/p/[slugId].astro:103`, `apps/web/src/pages/f/[slugId].astro:106` and `:126`.

9c. PARTIAL: many route handlers use `buildServiceContext({ cookies, request, workspaceId? })` and pass `ctx` to services. Deviations remain in SSR and helper layers. The pattern is not enforced.

9d. TRUE/PARTIAL: `apps/web/src` imports services from `@vegastack/pages-services` broadly. `packages/services` does import pure helpers/types from `@vegastack/pages-core`, including `renderTemplateBody` in `packages/services/src/templates.service.ts:25-31`, but no legacy service class instantiation was found in production services. `packages/renderer` imports only renderer libraries and has no D1/R2 imports.

9e. FALSE: log lines are not consistently JSON structured. Structured examples exist in worker. Ad-hoc logs include `apps/web/src/lib/service-context.ts:43`, `apps/web/src/pages/oauth/register.ts:54`, `apps/web/src/pages/img/[...key].ts:119`, and `apps/web/src/scripts/prose-enhancements.ts:120`.

9f. PARTIAL: load-bearing stale comments exist. `packages/services/src/publications.service.ts:359-360` says orphan can be collected by R2 lifecycle rule; live bucket has no such rule. `.changeset/clean-slate-rebuild.md` still claims retained legacy schema and Workers Images binding that are not in current config.

## 10. Dead code / legacy surface

10a. TRUE: production-code grep excluding tests and `runtime.ts` found only comments for the legacy service names:

```text
packages/services/src/repo/template.repo.ts:77:  // markdown/mdx body that callers can feed into pageService.create.
packages/services/src/index.ts:71:// resolvePageAccess / resolveFolderAccess / permissionService.assert,
packages/services/src/repo/attachment.repo.ts:8:// collection) is owned by `attachmentService` on apps/web.
packages/services/src/permissions.service.ts:386:// `permissionService.assert({actual, required})` shape so a one-line
```

10b. TRUE: test dirs under apps/packages did not match the specified legacy singleton names in the scoped grep. Core tests still instantiate legacy class services directly; see 10d.

10c. PARTIAL: `apps/web/src/lib/runtime.ts` is still 1286 lines. Legacy shim exports at `apps/web/src/lib/runtime.ts:405-431` include:

```ts
export async function acquireRuntimeMutationLock(): Promise<() => void> { ... }
export async function refreshRuntimeState() { ... }
export async function persistRuntimeState() { ... }
```

These should not remain in the production runtime once routes are migrated.

10d. PARTIAL: `packages/core/src/*Service` class files are not instantiated by production app/services code, but are still instantiated in tests:

```text
packages/core/src/core.test.ts:246:    const service = new PageService(new InMemoryObjectStore());
packages/core/src/core.test.ts:693:    const publications = new PublicationService();
packages/core/src/core.test.ts:970:    const workspaces = new WorkspaceService();
packages/core/src/core.test.ts:1320:    const auth = new AuthService();
packages/core/src/favorites.test.ts:26:    const service = new FavoriteService();
```

The files still hold exported types used by the repo. Do not delete until type exports are split from in-memory classes.

10e. PARTIAL: docs/plans state:

- `001-006`: draft/historical product docs.
- `007`: "Status: Plan, awaiting implementation approval." Superseded.
- `008`: "Status: Draft for review." Superseded.
- `009`: "Status: Draft for review. Supersedes plan 008." Superseded.
- `010`: "Status: Draft, awaiting maintainer approval. Supersedes Plans 007, 008, 009..." Partially executed and superseded.
- `011`: "Status: Draft, awaiting approval. Supersedes Plan 010..." Stale relative to 012/013.
- `012`: "Status: Draft, awaiting maintainer approval. Supersedes Plan 011 §17..." Partially stale after implementation.
- `013`: current continuation note, but contains at least one wrong claim about image upload: it says the server route "accepts the body"; current server route expects JSON base64 while the new client sends a Blob.

10f. FALSE: `.changeset/clean-slate-rebuild.md` is stale. It says legacy schema elements are retained and Workers Images binding is enabled; current `0001_init.sql` and `apps/web/wrangler.jsonc` do not match.

## 11. Observability + ops

11a. TRUE/PARTIAL: local `/api/health` only checks liveness and does not touch D1/R2 at `apps/web/src/pages/api/health.ts:1-9`. Local `/api/ready` checks D1 with `SELECT 1` and R2/object-store with `list(".healthcheck/")` at `apps/web/src/pages/api/ready.ts:29-43`.

11b. TRUE for branch code: middleware adds `server-timing: vpg;dur=<ms>` at `apps/web/src/middleware.ts:27-36` and applies it at `:127` and `:157`. TRUE for live old deployment: curl 404 responses included `server-timing`.

11c. TRUE: slow request threshold is env-configurable via `VPG_SLOW_REQUEST_LOG_MS` at `apps/web/src/middleware.ts:20-25`.

11d. TRUE: tail window produced no logs. Nothing noisy or PII-leaking observed.

11e. PARTIAL: runbook exists. It documents destructive cutover at `docs/operator-runbook.md:123-183`, but commands are not fully current/testable. It references `wrangler r2 object list` at `docs/operator-runbook.md:160-164` and `wrangler triggers list` at `docs/operator-runbook.md:323`; both failed locally with Wrangler 4.90.0.

11f. PARTIAL: backup path is documented as GitHub workspace backup and Cloudflare D1 time travel at `docs/operator-runbook.md:294-299`. There is no tested D1 export/import restore command or R2 backup/restore path.

11g. PARTIAL: incident response table covers "Every request 500", magic links, public page 404, `/api/ready` R2 failure, and cron not firing at `docs/operator-runbook.md:315-323`. It does not cover D1 outage, R2 outage beyond healthcheck, Cache API outage, or full `pages.vegastack.com` outage with concrete rollback/communication steps.

## 12. Free-form

12a. Top 3 extra risks:

1. Release workflow overwrites canonical `apps/web/wrangler.jsonc` with stale generated config, including KV and one cron. This can ship a different Worker than reviewed.
2. Public-by-key attachments rely on SHA-256 object-key secrecy. Once a URL leaks through a public page or audit/export, `/img/attachments/...` has no auth recheck.
3. `runtime.ts` still owns compatibility shims and module-level state. A future route can accidentally import a legacy helper and reintroduce process-local behavior.

12b. Top 3 small follow-up PRs to ship first:

1. Make `pnpm format` pass and update stale plan docs/changeset code fences.
2. Replace page soft-delete publication update with `publications.revoke` plus cache invalidation.
3. Fix image upload route to accept binary Blob uploads with content-type/size allowlist and persist width/height.

12c. Safest rollback target on `main`: `v0.1.13` / commit `8fddc96`. It is current `origin/main` and matches live production lineage. Do not roll forward this branch until the P1 list is fixed.

## Findings ranked by severity

- id: BUILD-01
  severity: P1
  title: CI formatting gate fails
  location: infra: `pnpm format`
  impact: CI blocks merge/release; two plan docs contain invalid Markdown/code syntax for Prettier.
  recommended fix: Fix `docs/plans/011-fresh-clean-slate.md` and `docs/plans/012-production-readiness-final.md` code fences/ellipsis, then run `pnpm format`.

- id: OPS-01
  severity: P1
  title: Release workflow deploys stale config with KV
  location: `.github/workflows/release.yml:367`
  impact: Stable release can deploy a Worker with `SESSION` KV and only one cron, contradicting reviewed `apps/web/wrangler.jsonc` and the "NO KV" release requirement.
  recommended fix: Stop generating `wrangler.jsonc` in release workflow; substitute placeholders in canonical config or verify `dist/server/wrangler.json` has no KV and both crons.

- id: REL-01
  severity: P1
  title: Page soft-delete leaves public artifact and cache live
  location: `packages/services/src/pages.service.ts:916`
  impact: Deleted public pages can remain accessible from R2/edge cache because latest artifact fields are not nulled, R2 key is not deleted, and cache is not purged.
  recommended fix: Replace inline publication update with `publications.revoke(ctx, publication.id)` and route-layer cache invalidation for `/p/{slug}`.

- id: REL-02
  severity: P1
  title: Page save can point at missing version row
  location: `packages/services/src/pages.service.ts:628`
  impact: If `page_versions` insert fails after the page row update, page history and current `version_id` become inconsistent.
  recommended fix: Batch page update and version insert, or insert version first and update the page in one atomic batch with rollback cleanup for the new R2 object.

- id: SEC-01
  severity: P1
  title: Publication passwords use salted SHA-256
  location: `packages/services/src/publications.service.ts:14`
  impact: Offline disclosure of D1 enables fast GPU cracking of publication passwords.
  recommended fix: Use PBKDF2, scrypt, or argon2id with versioned hashes; migrate existing `sha256:` hashes on next password set/verification.

- id: SEC-02
  severity: P1
  title: Dependency audit reports high vulnerability
  location: infra: `pnpm audit --audit-level high`
  impact: `devalue` DoS via sparse array deserialization is present through `apps__web>@astrojs/react>devalue`.
  recommended fix: Upgrade dependency chain to `devalue >=5.8.1` or patch/resolution-pin and rerun audit.

- id: BUG-01
  severity: P1
  title: Compressed image upload client does not match server contract
  location: `apps/web/src/scripts/upload-image.ts:134`
  impact: Client sends a Blob with image headers; server requires JSON `base64_body`, `filename`, `content_type` and stores base64 length as byte size. Image upload fails or stores wrong bytes.
  recommended fix: Change the route to accept binary body with `content-type`, `x-filename`, `x-image-width`, `x-image-height`, and a byte cap; store raw bytes through a binary-capable object store.

- id: SEARCH-01
  severity: P1
  title: Page body text is never indexed
  location: `packages/services/src/search.service.ts:233`
  impact: Search misses page body content because indexer reads `source-${updated_at}.md` while saved objects are keyed by content hash.
  recommended fix: Select `object_key_current` and `source_type` in `scheduleIndexPage` and reconciler; read that object and index rendered/plain text.

- id: PERF-01
  severity: P1
  title: Workspace-wide list paths are unbounded
  location: `packages/services/src/pages.service.ts:379`
  impact: Large workspaces can exceed D1 subrequest, memory, and CPU budgets on public page/folder render and attachment list routes.
  recommended fix: Add paginated/cursor list APIs and specialized count/list queries for navigation, folder publication, comments, and attachments.

- id: R2-01
  severity: P2
  title: No R2 orphan lifecycle exists
  location: infra: Cloudflare R2 lifecycle output
  impact: Failed D1 writes and best-effort deletes accumulate objects forever; code comments rely on a lifecycle rule that is absent.
  recommended fix: Add dashboard/Terraform lifecycle policy or a scheduled GC job keyed by current D1 object references.

- id: SEC-03
  severity: P2
  title: Attachment content types are too permissive
  location: `packages/services/src/attachments.service.ts:68`
  impact: SVG/HTML/JSON/PDF and filename-derived extensions can expose active or misleading content through public-by-key `/img/attachments/*`.
  recommended fix: Restrict image proxy uploads to PNG/JPEG/WebP/AVIF; serve non-images through authenticated download route with `Content-Disposition: attachment`.

- id: OAUTH-01
  severity: P2
  title: OAuth token endpoint has no request body size cap
  location: `apps/web/src/pages/oauth/token.ts:67`
  impact: Large JSON/form bodies can waste Worker memory before validation.
  recommended fix: Reuse bounded `readJsonBody`/text reader with a small OAuth-specific limit before parsing JSON/form data.

- id: CRON-01
  severity: P2
  title: Search reconciler stops on first workspace failure
  location: `apps/web/src/lib/search-reconciler.ts:36`
  impact: One bad workspace prevents all later workspaces from healing search index drift.
  recommended fix: Process workspaces with bounded concurrency and `Promise.allSettled`; log per-workspace failures and continue.

- id: OBS-01
  severity: P2
  title: Logs are not consistently structured
  location: `apps/web/src/pages/oauth/register.ts:54`
  impact: Raw `console.error(error)` can emit stack traces and inconsistent payloads; log search/alerting becomes brittle.
  recommended fix: Route logs through `ctx.log`/JSON helper with `event`, redacted `error`, and stable fields.

- id: LEGACY-01
  severity: P2
  title: Runtime legacy shims remain exported
  location: `apps/web/src/lib/runtime.ts:405`
  impact: Future production code can accidentally rely on no-op mutation locks or runtime snapshot shims.
  recommended fix: Delete unused shims after route migration; split unavoidable helpers into small modules.

- id: DOCS-01
  severity: P2
  title: Runbook commands are stale
  location: `docs/operator-runbook.md:160`
  impact: Operators following the runbook will hit unsupported Wrangler commands during cutover/incident response.
  recommended fix: Update commands for installed Wrangler/API flow; add tested D1/R2 backup and restore procedures.

## Appendix — commands run and verbatim output

### `pnpm install`

```text
Scope: all 10 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

   ╭──────────────────────────────────────────╮
   │                                          │
   │   Update available! 10.33.2 → 11.1.3.   │
   │   Changelog: https://pnpm.io/v/11.1.3   │
   │     To update, run: pnpm add -g pnpm     │
   │                                          │
   ╰──────────────────────────────────────────╯

Done in 667ms using pnpm v10.33.2
```

### `pnpm typecheck`

```text
> vegastack-pages@0.1.13 typecheck /Users/kmanojkumar/code/vegastack-pages
> pnpm -r --if-present typecheck

Scope: 9 of 10 workspace projects
packages/core typecheck$ tsc --noEmit
packages/core typecheck: Done
packages/db typecheck$ tsc --noEmit
packages/db typecheck: Done
packages/renderer typecheck$ tsc --noEmit
packages/config typecheck$ tsc --noEmit
packages/renderer typecheck: Done
packages/config typecheck: Done
packages/mcp typecheck$ tsc --noEmit
packages/services typecheck$ tsc --noEmit
packages/ui typecheck$ tsc --noEmit
packages/mcp typecheck: Done
packages/ui typecheck: Done
packages/services typecheck: Done
apps/web typecheck$ astro check
apps/web typecheck: (node:54827) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.
apps/web typecheck: 13:52:33 [@astrojs/cloudflare] Enabling compile-time image optimization. Images will be pre-optimized at build time.
apps/web typecheck: 13:52:33 [@astrojs/cloudflare] Enabling sessions with Cloudflare KV with the "SESSION" KV binding.
apps/web typecheck: src/pages/api/integrations/github/start.ts:45:11 - warning ts(6133): 'ctx' is declared but its value is never read.
apps/web typecheck: src/pages/app/login.astro:4:1 - warning ts(6133): 'loginRedirectTarget' is declared but its value is never read.
apps/web typecheck: src/pages/app/signup.astro:4:1 - warning ts(6133): 'loginRedirectTarget' is declared but its value is never read.
apps/web typecheck: Result (259 files):
apps/web typecheck: - 0 errors
apps/web typecheck: - 0 warnings
apps/web typecheck: - 3 hints
apps/web typecheck: Done
```

### `pnpm test`

```text
> vegastack-pages@0.1.13 test /Users/kmanojkumar/code/vegastack-pages
> vitest run

RUN v4.1.5 /Users/kmanojkumar/code/vegastack-pages
Test Files 64 passed (64)
Tests 434 passed (434)
Start at 13:52:58
Duration 14.19s (transform 5.73s, setup 800ms, import 27.40s, tests 20.79s, environment 10ms)
```

### `pnpm exec vitest run --reporter verbose`

```text
Test Files 64 passed (64)
Tests 434 passed (434)
Duration 14.43s (transform 5.68s, setup 947ms, import 31.15s, tests 23.05s, environment 7ms)
apps/web/src/pages/oauth/_tests/oauth-flow.test.ts > Device authorization grant > issues a device_code + user_code; approval lets the CLI redeem 6039ms
apps/web/src/pages/oauth/_tests/oauth-flow.test.ts > Device authorization grant > accepts the well-known vpg-cli client_id without registration and returns workspace_id 6013ms
```

### `pnpm --filter @vegastack/pages-web build`

```text
> @vegastack/pages-web@0.1.13 build /Users/kmanojkumar/code/vegastack-pages/apps/web
> wrangler types && VPG_RUNTIME=cloudflare astro build && pagefind --site dist/client --output-subdir pagefind

wrangler 4.90.0
Generating project types...
interface Env {
 CONTENT: R2Bucket;
 DB: D1Database;
 EMAIL: SendEmail;
 ACTIONS_RL: RateLimit;
 ASSETS: Fetcher;
 VPG_RUNTIME: "cloudflare";
 VPG_DEPLOYMENT_MODE: "managed";
 VPG_PUBLIC_SIGNUP: "true";
 VPG_HOME_MODE: "landing";
 VPG_BASE_URL: "https://pages.vegastack.com";
 VPG_EMAIL_FROM: "login@pages.vegastack.com";
 VPG_EMAIL_FROM_NAME: "VegaStack Pages";
 VPG_EMAIL_PROVIDER: "auto";
}
Types written to worker-configuration.d.ts
(node:55234) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.
13:53:26 [@astrojs/cloudflare] Enabling compile-time image optimization...
13:53:26 [@astrojs/cloudflare] Enabling sessions with Cloudflare KV with the "SESSION" KV binding.
build complete, prerendered docs routes, server built in 20.75s.
Pagefind v1.5.2: Indexed 15 pages, 1140 words, 0 filters, 0 sorts.
```

### `pnpm audit --audit-level high`

```text
high | Svelte devalue: DoS via sparse array deserialization
Package devalue
Vulnerable versions >=5.6.3 <=5.8.0
Patched versions >=5.8.1
Paths apps__web>@astrojs/react>devalue
More info https://github.com/advisories/GHSA-77vg-94rm-hx3p
7 vulnerabilities found
Severity: 6 moderate | 1 high
```

### `pnpm format`

```text
> vegastack-pages@0.1.13 format /Users/kmanojkumar/code/vegastack-pages
> prettier --check .

Checking formatting...
[warn] apps/web/src/lib/__tests__/publication-cache.test.ts
[warn] apps/web/src/lib/access.ts
[warn] apps/web/src/lib/comments-enrich.ts
[warn] apps/web/src/lib/github-backup.ts
[warn] apps/web/src/lib/publication-cache.ts
[warn] apps/web/src/lib/runtime.ts
[warn] apps/web/src/lib/settings-data.ts
[warn] apps/web/src/lib/signup-intents.ts
[warn] apps/web/src/lib/workspace-navigation.ts
[warn] apps/web/src/lib/workspace-visibility.ts
[warn] apps/web/src/pages/mcp.ts
[warn] apps/web/src/pages/p/[slugId].astro
[warn] apps/web/src/scripts/upload-image.ts
[warn] docs/audits/2026-05-17-production-readiness.md
[warn] docs/operator-runbook.md
[error] docs/plans/011-fresh-clean-slate.md: SyntaxError: Unexpected token (15:38)
[error]   13 | if (publication.passwordHash) {
[error]   14 |   if (!await verifyPasswordCookie(ctx, publication)) {
[error] > 15 |     return passwordPromptResponse(...);
[error]      |                                      ^
[error] docs/plans/012-production-readiness-final.md: SyntaxError: Invalid character. (16:52)
[error]   14 |   const { ctx, actor } = await buildServiceContext({ cookies, request });
[error]   15 |   try {
[error] > 16 |     const result = await pages.updateSource(ctx, { … });
[error]      |                                                    ^
Error occurred when checking code style in 2 files.
 ELIFECYCLE  Command failed with exit code 2.
```

### `pnpm --filter @vegastack/pages test`

```text
> @vegastack/pages@0.1.13 test /Users/kmanojkumar/code/vegastack-pages/cli/vegastack-pages
> node --test test/*.test.mjs

✔ launcher reports version (134.709167ms)
✔ launcher resolves platform binaries without shell-specific assumptions (0.295541ms)
✔ npm package includes README and license (802.415958ms)
✔ cross-build stages platform packages with license metadata (0.636875ms)
✔ source manifest defers native optional packages until publish (0.081458ms)
✔ pack-platforms injects exactly the supported native packages (0.398375ms)
✔ native build script uses platform path delimiters and Windows home fallback (0.915209ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 990.055916
```

### `cargo test --manifest-path cli/vegastack-pages/Cargo.toml`

```text
zsh:1: command not found: cargo
```

### Cloudflare production probes

```text
wrangler whoami
Logged in as mk@vegastack.com.
Account Name: VegaStack (PeerXP)
Account ID: d8d3a8313371b96024d5fb5f31baf6c9
```

```text
wrangler deployments list --config wrangler.jsonc
Created: 2026-05-15T19:44:42.813Z
Version ID: ec9de04d-fb38-4ead-9fa7-69f9079e529c
Source: Unknown (deployment)
```

```text
wrangler kv namespace list --config wrangler.jsonc
vegastack-pages-sessions-prod f651e62192514a498d94b3f0277e0091
```

```text
wrangler secret list --config wrangler.jsonc
AWS_ACCESS_KEY_ID
AWS_REGION
AWS_SECRET_ACCESS_KEY
MAGIC_LINK_SECRET
SESSION_SECRET
SETUP_TOKEN_SECRET
VPG_EMAIL_FROM
VPG_EMAIL_FROM_NAME
VPG_EMAIL_PROVIDER
VPG_SETUP_TOKEN
```

```text
wrangler d1 list --config wrangler.jsonc
vegastack_pages_prod e85aea0b-8068-430a-a2b6-53a74dc591e6 created 2026-05-11T19:52:18.880Z
```

```text
wrangler d1 execute vegastack_pages_prod --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
_cf_KV
agent_sessions
attachments
audit_logs
auth_identities
auth_sessions
comment_anchors
comment_replies
comment_threads
d1_migrations
folders
github_sync_connections
github_sync_runs
jobs
magic_links
mcp_sessions
oauth_clients
oauth_grants
page_favorites
page_versions
pages
permissions
publications
rate_limits
review_events
runtime_locks
runtime_state
search_documents
search_recent_resources
setup_state
share_links
users
workspace_members
workspace_template_versions
workspace_templates
workspaces
```

```text
wrangler triggers list --config wrangler.jsonc
ERROR Unknown argument: list
wrangler triggers
COMMANDS
  wrangler triggers deploy ...
```

```text
wrangler r2 object list vegastack-pages-content --prefix attachments/ --remote --config wrangler.jsonc
ERROR Unknown arguments: prefix, remote, list, vegastack-pages-content
```

```text
curl -i https://pages.vegastack.com/api/ready
HTTP/2 404
server-timing: vpg;dur=6224.8
content-type: text/html
```

```text
curl -i https://pages.vegastack.com/health
HTTP/2 404
server-timing: vpg;dur=6235.2
content-type: text/html
```

```text
curl -i https://pages.vegastack.com/.well-known/oauth-authorization-server
HTTP/2 200
access-control-allow-origin: *
cache-control: public, max-age=300
content-type: application/json
```

```text
curl -i https://pages.vegastack.com/.well-known/oauth-protected-resource
HTTP/2 200
access-control-allow-origin: *
cache-control: public, max-age=300
content-type: application/json
```

### Git reference

```text
8cd94e3 (HEAD -> feat/instant-workspace-v1) chore(infra): canonical wrangler.jsonc + drop VPG_ADAPTER (plan 010 phase 2)
8fddc96 (tag: v0.1.13, origin/main, origin/HEAD, main) feat: release v0.1.13 performance and MCP consolidation
```
