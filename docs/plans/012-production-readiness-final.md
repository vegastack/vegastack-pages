# Plan 012 — Production-readiness final pass

**Status:** Draft, awaiting maintainer approval.
**Supersedes:** Plan 011 §17 deviation log (executes everything that plan left open).
**Owner:** @mk
**Drafted:** 2026-05-18
**Branch:** `feat/instant-workspace-v1`

---

## 1. Why this plan exists

Plan 011 (`docs/plans/011-fresh-clean-slate.md`) drafted the clean-slate rebuild and was executed through session 1 ending 2026-05-17:

- ✅ Days 2–8 (schema + 17 direct-D1 services + 16 service tests, 407 passing)
- ✅ wrangler.jsonc canonicalization (committed)
- ✅ Route consolidation to `/app/*` (committed)
- ✅ Dead-code purge phase 1 (committed)
- ❌ Day 1 (live-infra inventory)
- ❌ Day 3a (`runtime.ts` shrink) — 2,900 LOC remain
- ❌ Day 3b (middleware shrink) — still runs the legacy snapshot/mutation-lock loop
- ❌ Day 9 (save-time render pipeline)
- ❌ Day 10 (publish fan-out + public read path rewrite)
- ❌ Day 11 (image pipeline)

The bridge that keeps both the legacy in-memory services AND the new direct-D1 services alive at the same time is intentional per Plan 011 §17, but the result is that the app at HEAD is mid-rewrite, not production-ready. Plan 012 finishes the work.

## 2. Non-goals

- No new product features beyond what 011 already specified.
- No new infrastructure dependencies beyond AWS SES (already in 011).
- No back-compat shims. Plan 011 §1 binds us to: _"No legacy fallbacks. No graceful migration. Truncate live D1, reset live R2 prefixes, deploy fresh."_
- No client-side framework migration. Keep React islands for interactive controls; Astro for SSR.

## 3. Current state snapshot

```
Branch: feat/instant-workspace-v1 (4 committed commits + 132 uncommitted files)
Tests:  61 files / 407 passing
Build:  apps/web ✅  | cli ❌ (missing node_modules — `pnpm install` fixes)
Type:   ✅ 0 errors, 2 hints (loginRedirectTarget unused imports — to be removed)

Hot files:
  apps/web/src/lib/runtime.ts         2,900 LOC (target <200)
  apps/web/src/middleware.ts            185 LOC (legacy mutation-lock loop)
  apps/web/src/pages/mcp.ts          2,644 LOC (still imports legacy singletons)
  apps/web/src/lib/github-backup.ts   1,295 LOC (legacy lock + persist)
  apps/web/src/lib/access.ts            616 LOC (legacy auth/workspace singletons)
  packages/db/migrations/0001_init.sql  615 LOC (legacy cols still present)

Services (D1-direct, complete, tested):
  packages/services/src/*.service.ts  (17 files, ~150 KB)
  Repo interfaces: packages/services/src/repo/*.repo.ts

Legacy consumer count (non-test):
  - 40+ pages/api/** routes import from "../../../lib/runtime"
  - 6 lib/* helpers import legacy singletons
  - pages/mcp.ts + pages/*.astro public routes still use legacy services
  - 100+ occurrences of forbidden DoD identifiers
```

## 4. Architecture lock (final)

Per Plan 011 §1 — locked, no deviation:

```
              Browser • MCP client • CLI → HTTPS → pages.vegastack.com (CF DNS+WAF+RL)
                                                       │
                              Single Cloudflare Worker (smart placement, nodejs_compat)
                              Astro 6 SSR · @astrojs/cloudflare 13 · custom worker.ts
                                                       │
                                       Middleware (~40 LOC): resolveActor (1 D1 read) ·
                                       CSRF · ACTIONS_RL · CSP/HSTS/X-Frame/COOP/PP
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                          ┌─────┐                  ┌─────┐                ┌─────────┐
                          │ D1  │                  │  R2 │                │ AWS SES │
                          │     │                  │  CONTENT             │ (SigV4 │
                          │ all │                  │  pages/{ws}/{pg}/    │ via   │
                          │tables               │   source-{hash}.{ext} │ aws4fetch)│
                          │+FTS5│                  │   rendered-{hash}.html       │
                          │     │                  │  pub/{pubId}/{hash}.html
                          │     │                  │  attachments/{ws}/{sha}.webp
                          │     │                  │  mermaid/{sha}.svg   │
                          └─────┘                  └─────┘                └─────────┘

Cron triggers: 0 3 * * * (GitHub backup) · 30 3 * * * (search reconciler)

Bindings: DB (D1), CONTENT (R2), ACTIONS_RL (per-user rate), EMAIL (CF fallback),
          ASSETS (Astro client bundle). NO KV. NO IMAGES.
```

## 5. Phases (execute in this order)

| #   | Phase                                      | Output                                                 | Blocked by   |
| --- | ------------------------------------------ | ------------------------------------------------------ | ------------ |
| A   | Schema finalization                        | `0001_init.sql` legacy-cleaned + `types.ts` aligned    | —            |
| B   | Route + lib migration                      | 0 legacy singleton imports outside `runtime.ts`        | A            |
| C   | `runtime.ts` shrink to ~150 LOC            | Legacy singletons + snapshot/persist machinery deleted | B            |
| D   | `middleware.ts` shrink to ~40 LOC of logic | No mutation lock, no hydration                         | C            |
| E   | Save-time render pipeline                  | `packages/renderer/src/save-time-render.ts` + tests    | — (parallel) |
| F   | Publish fan-out                            | `publishFanOut` in `publications.service.ts`           | E            |
| G   | Public read path rewrite                   | `/p/[slugId]` + `/f/[slugId]` on R2 + Cache API        | F            |
| H   | Image pipeline                             | `/img/[...key]`, `upload-image.ts` client compress     | — (parallel) |
| I   | KV/IMAGES/session-driver final cleanup     | `grep` proves zero matches                             | C, H, I      |
| J   | AWS SES via `aws4fetch`                    | `apps/web/src/lib/email.ts` rewrite                    | — (parallel) |
| K   | Ops endpoints + crons                      | `/api/ready`, search reconciler wired in `worker.ts`   | C            |
| L   | Tests ≥400 + integration suite             | New per-service + integration + render tests           | E, F, G, H   |
| M   | Final 5-agent audit + DoD verification     | Zero BLOCKER, zero HIGH                                | A–L          |

Phases E, H, J can run in parallel with B/C/D since they touch different files.

### Phase A — Schema (remove legacy)

`packages/db/migrations/0001_init.sql`:

- DROP block `runtime_state` (no longer in use)
- DROP block `runtime_locks` (no longer in use)
- DROP column `pages.render_cache_key`
- DROP column `comment_anchors.reanchor_status`
- DROP column `agent_sessions.redirect_uris_json` (line 471)
- DROP `jobs` table block if any (verify)
- VERIFY every JSON column has `CHECK (json_valid(x))`

Update `packages/db/src/types.ts` to match.

Test fix: `packages/services/src/__tests__/test-db.ts` (in-memory better-sqlite3) loads `0001_init.sql`. Any test depending on the dropped columns needs the column expectation removed.

### Phase B — Migrate consumers to direct-D1 services

For each consumer, replace `import { pageService, … } from "../../../lib/runtime"` with the route-level `buildServiceContext({cookies, request, workspaceId})` from `apps/web/src/lib/service-context.ts`, then call `pages.<method>(ctx, args)` etc.

Pattern (already established in the migrated routes):

```ts
// BEFORE (legacy)
import { ensureSeedData, pageService } from "../../../lib/runtime";
import { getApiRequestActor } from "../../../lib/access";
export const POST: APIRoute = async ({ request, cookies }) => {
  await ensureSeedData();
  const actor = await getApiRequestActor(cookies, request);
  // ... business logic on pageService ...
};

// AFTER (direct-D1)
import { pages, isServiceError } from "@vegastack/pages-services";
import {
  buildServiceContext,
  jsonAppError,
} from "../../../lib/service-context";
export const POST: APIRoute = async ({ request, cookies }) => {
  const { ctx, actor } = await buildServiceContext({ cookies, request });
  try {
    const result = await pages.updateSource(ctx, {
      /* ...inputs */
    });
    return jsonWithEnvelope(result.data, result.envelope);
  } catch (error) {
    if (isServiceError(error)) return jsonAppError(error);
    throw error;
  }
};
```

Per-resource permission checks stay at the route layer (`resolvePageAccess`, `resolveFolderAccess`, `permissionService.assert(ctx, …)`). Authentication is now part of `buildServiceContext`.

`ensureSeedData()` calls go away entirely — replaced by the explicit `/api/setup/complete` flow that creates the first user + workspace exactly once.

Files to migrate (40+):

```
apps/web/src/pages/api/audit-logs/index.ts
apps/web/src/pages/api/auth/{dev-login,logout,signup}.ts
apps/web/src/pages/api/auth/magic-link/{request,verify}.ts
apps/web/src/pages/api/integrations/github/{start,callback}.ts
apps/web/src/pages/api/mcp/sessions.ts
apps/web/src/pages/api/pages/[pageId]/*.ts   (already partially done)
apps/web/src/pages/api/folders/[folderId]/*.ts (already partially done)
apps/web/src/pages/api/comment-threads/...   (already done)
apps/web/src/pages/api/publications/[publicationId]/*.ts
apps/web/src/pages/api/review-events.ts
apps/web/src/pages/api/search.ts
apps/web/src/pages/api/setup/{status,complete}.ts (already partially done)
apps/web/src/pages/api/templates/...   (already partially done)
apps/web/src/pages/api/validate-source.ts
apps/web/src/pages/api/workspaces/...   (already partially done)
apps/web/src/pages/oauth/authorize.ts
apps/web/src/pages/oauth/authorize/consent.ts
apps/web/src/pages/oauth/device/verify.ts
apps/web/src/pages/p/[slugId].astro      (also Phase G)
apps/web/src/pages/f/[slugId].astro      (also Phase G)
apps/web/src/pages/app/setup.astro
apps/web/src/pages/app/index.astro
apps/web/src/pages/app/settings/*.astro
apps/web/src/pages/app/settings/connections/workspace.astro
apps/web/src/pages/app/settings/templates/[templateId].astro
apps/web/src/pages/mcp.ts                (2,644 LOC — biggest file)
apps/web/src/lib/github-backup.ts        (1,295 LOC)
apps/web/src/lib/access.ts               (resolvePageAccess uses authService)
apps/web/src/lib/workspace-navigation.ts (favorites/pages/workspaces)
apps/web/src/lib/settings-data.ts
```

### Phase C — Shrink `runtime.ts`

After Phase B, `runtime.ts` has no consumers of its singletons. Reduce it to the binding/adapter surface only:

```ts
// apps/web/src/lib/runtime.ts (target ~150 LOC)
export type CloudflareBindings = {
  DB: D1Database;
  CONTENT: R2Bucket;
  ACTIONS_RL: RateLimit;
  EMAIL?: SendEmail;
  ASSETS?: Fetcher;
  // No KV, no IMAGES.
};
export async function getRuntimeBindings(): Promise<CloudflareBindings | null>;
export async function getDb(): Promise<D1Database>;
export async function getObjectStore(): Promise<ObjectStore>;
export { d1All, d1Run, d1Batch, d1AllRows } from "@vegastack/pages-db";
export { sha256Hex } from "./crypto";
export function isNodeRuntime(): boolean;
// Node adapter loaded lazily via dynamic import — never bundled into the CF Worker.
```

DELETE (whole sections of the file):

- `RuntimeSnapshot` + every snapshot helper (mapEntries/restoreMap/serviceMapValues)
- `hydrateRuntimeState`, `hydrateNormalizedRuntimeState`, `ensureRuntimeReady`, `refreshRuntimeState`, `rebuildSearchIndexFromRuntime`
- `acquireRuntimeMutationLock`, `persistRuntimeState`, `persistNormalizedRuntimeState{,Batch}`, `deleteNormalizedRuntimeState`
- `hydrateNodeState`, `persistNodeState`
- All service singletons (`pageService`, `workspaceService`, `commentService`, `favoriteService`, `authService`, `templateService`, `attachmentService`, `setupService`, `rateLimitService`, `mcpService`)
- `CREATE TABLE IF NOT EXISTS` bootstrap (migrations are truth)
- `normalizeCommentAnchorRecord` + helpers
- `legacyMcpSessionListId`, `maskListedMcpSession`, `resolveStoredMcpSessionId`
- `fallbackMcpSessions`, `fallbackRefreshIndex` Maps
- `runtimeHydratedFromNormalizedTables`
- `pruneExpiredVersions` (moves to a 30-day cron if retention is still wanted; otherwise dropped — workspace_retention is handled inline by `pages.service.ts` on each version write per Plan 011 §6)
- `ensureSeedData` (deleted; /api/setup is the only entry point)
- `renderCachedMarkdown` (request-time render is gone; everything is artifact-served)

DELETE adjacent files:

- `apps/web/src/lib/runtime/repos/` (whole dir — in-memory adapter shims, already-staged for deletion in git)
- `apps/web/src/lib/render-cache.ts`
- `apps/web/src/lib/middleware-policy.ts`
- `apps/web/src/pages/api/pages/[pageId]/rendered.ts` (artifact-served from R2 now)
- `packages/core/src/{page-service,workspaces,comments,auth,publications,access-control,attachments,favorites,audit,review-events,search,template-service,rate-limit,setup,events}.ts`

KEEP under `packages/core/src/`:

- `errors.ts` (AppError)
- `ids.ts` (id prefixes + slug helpers)
- `object-store.ts` (R2+Node FS facade interface)
- `permissions.ts` (pure permission resolution — used by `permissions.service.ts` and `access.ts`)
- `anchors.ts` (pure anchor coercion)
- `template-builder.ts`, `template-builtins.ts` (used by `templates.service.ts`)

### Phase D — Shrink `middleware.ts`

```ts
import { defineMiddleware } from "astro:middleware";
import { resolveActor } from "./lib/access";
import { assertCsrf, isUnsafeMethod, isOauthOrMcp } from "./lib/csrf";
import { assertActionRateLimit } from "./lib/rate-limit-action";
import { applySecurityHeaders } from "./lib/security-headers";
import { setCloudflareWaitUntil } from "./lib/runtime";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const startedAt = performance.now();
  if (ctx.locals.cfContext) {
    setCloudflareWaitUntil((p) => ctx.locals.cfContext.waitUntil(p));
  }
  ctx.locals.actor = await resolveActor(ctx);
  const url = new URL(ctx.request.url);
  if (isUnsafeMethod(ctx.request) && !isOauthOrMcp(url.pathname)) {
    assertCsrf(ctx); // throws CSRF_BLOCKED 403
  }
  if (url.pathname.startsWith("/_actions/") && ctx.locals.actor.userId) {
    await assertActionRateLimit(ctx); // ACTIONS_RL binding
  }
  const response = await next();
  if (response.headers.get("content-type")?.startsWith("text/html")) {
    applySecurityHeaders(response, url);
  }
  logSlowRequest(ctx.request, response.status, performance.now() - startedAt);
  return withServerTiming(response, performance.now() - startedAt);
});
```

No mutation lock. No hydrate. No persist. No `pruneExpiredVersions`. Each route owns its own atomicity via `db.batch([...])`.

### Phase E — Save-time render pipeline

`packages/renderer/src/save-time-render.ts`:

DEPS (verified Worker-safe):

```jsonc
{
  "unified": "^11",
  "remark-parse": "^11",
  "remark-gfm": "^4",
  "remark-rehype": "^11",
  "remark-math": "^6",
  "rehype-katex": "^7",
  "katex": "^0.16",
  "rehype-sanitize": "^6",
  "rehype-stringify": "^10",
  "rehype-parse": "^9",
  "shiki": "^4",
  "@shikijs/rehype": "^4",
  "@shikijs/langs": "^4",
  "@shikijs/themes": "^4",
  "@shikijs/engine-javascript": "^4", // regex-only, smaller than oniguruma WASM
  "@mdx-js/mdx": "^3",
  "remark-mdx": "^3",
  "safe-mdx": "^0.6",
}
```

API:

```ts
export type RenderResult = {
  html: string;
  hasCode: boolean;
  hasMermaid: boolean;
  hasMath: boolean;
  hasWardley: boolean;
  hasCytoscape: boolean;
  hasIframe: boolean;
};

export async function renderAtSave(input: {
  source: string;
  sourceType: "markdown" | "mdx" | "html";
  signal?: AbortSignal;
}): Promise<RenderResult>;
```

PIPELINES:

```
markdown:
  remarkParse → remarkGfm → remarkMath
   → remarkRehype → @shikijs/rehype (engine: javascript, lazy lang loader)
   → rehype-katex
   → rehype-sanitize (extend defaultSchema for shiki classes, katex math spans,
     mermaid <svg>, data-* attributes used by client islands)
   → rehype-stringify

mdx:
  remarkParse + remarkMdx
   → safe-mdx walker { Callout, Tabs, Steps }   (no eval, no new Function)
   → HTML string

html:
  rehypeParse(fragment:true) → rehype-sanitize (strict) → rehype-stringify
```

MERMAID: pre-rendered **client-side** in the editor (mermaid runs in the browser already at `apps/web/src/scripts/...`). The browser converts each ```mermaid block to inline `<svg>`and stores the SVG inside the source before save. The save-time pipeline preserves the`<svg>` blocks via the rehype-sanitize allowlist. Server bundle never imports mermaid.

FLAGS: walk the AST once, count `code` nodes (any), `code{lang: mermaid}` (mermaid), `math/inlineMath` (math), and check for known opening tags (Wardley/Cytoscape/iframe islands).

TESTS in `packages/renderer/src/__tests__/save-time-render.test.ts`:

- markdown with code/math/mermaid/wardley/cytoscape/iframe → correct flags + correct HTML markers
- MDX with allowed and disallowed components
- HTML source sanitized
- Malicious `<script>`, `onerror=`, `javascript:` URLs stripped

### Phase F — Publish fan-out

In `packages/services/src/publications.service.ts`:

```ts
export async function publishFanOut(
  ctx: ServiceContext,
  args: {
    publicationId: string;
    workspaceId: string;
    pageId: string;
    contentHash: string;
    slug: string;
    resourceType: "page" | "folder";
    publicOrigin: string;
  },
): Promise<void> {
  const db = requireDb(ctx);
  const objectStore = requireObjectStore(ctx);
  const renderedKey = `pages/${args.workspaceId}/${args.pageId}/rendered-${args.contentHash}.html`;
  const publicKey = `pub/${args.publicationId}/${args.contentHash}.html`;
  const rendered = await objectStore.get(renderedKey);
  if (!rendered)
    throw new ServiceError("INTERNAL", "Rendered artifact missing.");
  await objectStore.put(publicKey, await rendered.arrayBuffer(), {
    contentType: "text/html; charset=utf-8",
    customMetadata: { content_hash: args.contentHash, page_id: args.pageId },
  });
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE publications
       SET latest_artifact_key=?1, latest_content_hash=?2,
           latest_rendered_at=?3, updated_at=?3
     WHERE id=?4`,
    )
    .bind(publicKey, args.contentHash, now, args.publicationId)
    .run();
  ctx.waitUntil(
    invalidatePublicationCache(ctx, {
      origin: args.publicOrigin,
      slug: args.slug,
      resourceType: args.resourceType,
    }),
  );
}
```

TRIGGER POINTS:

- `pages.service.ts.updateSource` — after render, if a publication exists for the page (one D1 SELECT by `(workspaceId, resource_id)`)
- `publications.service.ts.upsert` — when newly created or config changes
- `publications.service.ts.revoke` — invalidate cache, no fan-out

`invalidatePublicationCache` calls `caches.default.delete(new Request(`${origin}/p/${slug}`))` and (if folder) `${origin}/f/${slug}`.

### Phase G — Public read path

Rewrite `apps/web/src/pages/p/[slugId].astro` and `apps/web/src/pages/f/[slugId].astro` per Plan 011 §8:

```astro
---
import { caches } from "cloudflare:workers"; // or Astro.locals.cfContext.caches
import { getDb, getObjectStore } from "../../lib/runtime";
import {
  findPublicationBySlug,
  computeCacheControl,
  verifyPasswordCookie,
} from "../../lib/publication-cache";
import { applySecurityHeaders } from "../../lib/security-headers";

export const prerender = false;

const cacheKey = new Request(Astro.url.toString(), Astro.request);
const cached = await caches.default.match(cacheKey);
if (cached) return cached;

const publication = await findPublicationBySlug(
  await getDb(),
  Astro.params.slugId,
);
if (!publication || publication.revokedAt)
  return new Response("Not found", { status: 404 });

if (publication.passwordHash) {
  const ok = await verifyPasswordCookie(Astro.cookies, publication);
  if (!ok) return passwordPromptResponse(Astro, publication);
}

const etag = `W/"${publication.latestContentHash}.${Date.parse(publication.latestRenderedAt).toString(36)}"`;
if (Astro.request.headers.get("if-none-match") === etag) {
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, "Cache-Control": computeCacheControl(publication) },
  });
}

const artifact = await (
  await getObjectStore()
).get(publication.latestArtifactKey);
if (!artifact) return await republishOnDemand(publication);
const showComments =
  publication.permission === "comment" || publication.permission === "edit";

const headers = new Headers({
  "content-type": "text/html; charset=utf-8",
  etag,
  "cache-control": computeCacheControl(publication),
});
if (publication.passwordHash) headers.set("vary", "Cookie");
if (!publication.indexingEnabled)
  headers.set("x-robots-tag", "noindex, nofollow");
const response = new Response(
  buildShellHTML({
    artifact: await artifact.text(),
    publication,
    showComments,
  }),
  { headers },
);
applySecurityHeaders(response, Astro.url);
Astro.locals.cfContext?.waitUntil(
  caches.default.put(cacheKey, response.clone()),
);
return response;
---
```

New helpers (`apps/web/src/lib/publication-cache.ts`):

- `findPublicationBySlug(db, slug)` — 1 D1 SELECT
- `computeCacheControl(pub)` per the matrix in plan §8
- `verifyPasswordCookie(cookies, pub)` — bcrypt-compare via existing helpers
- `passwordPromptResponse(astro, pub)` — minimal HTML form
- `buildShellHTML({ artifact, publication, showComments })` — wraps the baked artifact in the shell layout (PublicFolderSidebar etc.) and emits `<comments-island>` only when allowed
- `republishOnDemand(pub)` — race-recovery: re-fetch page, re-render, re-fan-out

DELETE: `apps/web/src/lib/render-cache.ts` (no longer used). DELETE: `apps/web/src/pages/api/pages/[pageId]/rendered.ts` (no request-time render).

### Phase H — Image pipeline

1. `apps/web/src/scripts/upload-image.ts` (NEW): client-side compression
   - `OffscreenCanvas` + `convertToBlob({ type: 'image/webp', quality: 0.85 })`
   - Run inside a Web Worker for editor responsiveness (postMessage transferable)
   - Feature-detect WebP support; Safari fallback to JPEG q=0.85
   - Returns `{ blob, width, height }`

2. Editor wiring (`apps/web/src/scripts/page-editor-codemirror.ts`):
   - On drop + paste events with images: call `compressBeforeUpload`, POST to `/api/pages/[pageId]/attachments` with `X-Image-Width`/`X-Image-Height` headers
   - Service writes R2 at `attachments/{wsId}/{sha256}.webp` + attachments row with image_width/image_height

3. `apps/web/src/pages/img/[...key].ts` (NEW): R2 image proxy with edge cache, immutable cache headers, ETag

4. Sweep `apps/web/src/assets/*` and components for `<Image />` usage (chrome only, build-time)

5. NO `IMAGES` binding anywhere. `astro.config.mjs` already has `imageService: { build: 'compile', runtime: 'passthrough' }`.

### Phase I — KV / IMAGES / session-driver final cleanup

VERIFY (via grep):

- `wrangler.jsonc` has no `kv_namespaces`, no `images` block ✅ (already)
- No `Astro.session.*` anywhere ✅ (already clean)
- No `process.env.VPG_ADAPTER` ✅ (already clean)
- No `IMAGES` binding type in `apps/web/src/env.d.ts` or runtime types
- No `kv_namespaces` examples in `install/cloudflare/wrangler.example.jsonc`

DOCUMENT in CLAUDE.md:

- "We don't use Astro.session. Astro adapter v13 emits `Enabling sessions with Cloudflare KV with the 'SESSION' KV binding` at build time; the binding is never read at runtime because no code touches Astro.session. Safe to ignore." (Astro v6 doesn't expose a `session: false` opt-out; the no-op cost is negligible.)

### Phase J — AWS SES via `aws4fetch`

`apps/web/src/lib/email.ts` rewrite. Provider order:

1. `VPG_EMAIL_PROVIDER=ses` OR (`auto` with `AWS_REGION+AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY` present) → SES via v2 SendEmail raw content endpoint
2. `VPG_EMAIL_PROVIDER=cloudflare` OR (`auto` with only `EMAIL` binding) → `env.EMAIL.send(...)` (MIME message)
3. Otherwise console log (dev)

MIME helper: `apps/web/src/lib/mime.ts` — `buildMimeMessage({ from, to, subject, html, text, replyTo? })`. Use `=?UTF-8?B?…?=` for non-ASCII headers.

aws4fetch usage:

```ts
import { AwsClient } from "aws4fetch";
const aws = new AwsClient({
  accessKeyId: env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  region: env.AWS_REGION,
  service: "ses",
});
const body = JSON.stringify({
  Content: { Raw: { Data: base64(mime) } },
  FromEmailAddress: from,
  Destination: { ToAddresses: [to] },
});
const res = await aws.fetch(
  `https://email.${env.AWS_REGION}.amazonaws.com/v2/email/outbound-emails`,
  { method: "POST", body, headers: { "content-type": "application/json" } },
);
```

Tests: provider selection logic, MIME shaping correctness.

### Phase K — Ops endpoints + crons

`apps/web/src/pages/api/health.ts` (already exists): verify shape `{ status: "ok", runtime, version }` + 200

`apps/web/src/pages/api/ready.ts` (already exists): verify it does the 3 checks; otherwise add:

- D1: `SELECT 1`
- R2: HEAD `.healthcheck` object (Phase K bootstrap creates it during deploy)
- SES: optional via env

`apps/web/src/worker.ts` cron handler:

```ts
async scheduled(event, env, ctx) {
  if (event.cron === "0 3 * * *") {
    ctx.waitUntil(runDueGitHubBackupSyncs(env));
  }
  if (event.cron === "30 3 * * *") {
    ctx.waitUntil(runSearchReconciler(env));
  }
}
```

`apps/web/src/lib/search-reconciler.ts` (already exists, untracked): verify it walks `pages`, `folders`, `comment_threads` and INSERT-OR-REPLACE rebuilds `search_documents` + FTS triggers handle FTS5 sync.

Structured logs (JSON via console.log):

- `vpg.cron.completed`, `vpg.cron.failed`
- `vpg.publish.completed { publication_id, content_hash, duration_ms }`
- `vpg.publish.failed`
- `vpg.render.failed { page_id, source_type, error }`
- `vpg.background.failed`
- `vpg.image.served { key, cache_hit, byte_size }` (sampled 1%)
- `vpg.email.sent`, `vpg.email.failed`

### Phase L — Tests to ≥400, integration

Already at 407; needs to grow to cover new code:

- save-time-render tests (~8)
- publishFanOut tests (~4)
- public-read-path tests (~6: cache hit/miss/304/password/view-only-no-comments/comment-permission-emits-island)
- /img route tests (~3)
- AWS SES selection tests (~3)
- pages.updateSource w/ render-and-publish integration (~3)
- worker scheduled handler tests (~2)
- Final target: ~420 tests.

Integration tests in `apps/web/src/pages/api/_tests/`:

- Magic-link e2e → session → /app
- Setup flow → admin + first workspace
- OAuth flow (re-verify)
- MCP create-page → publish → public read cache hit
- Comment on view-only publication → 404
- Comment on comment publication → 200
- Page-source update on published page → /p/ artifact updates + cache invalidates

### Phase M — Final audit + DoD

Five parallel agent passes (per plan §12):

1. Reliability + concurrency
2. Security
3. Consistency + pattern coherence
4. Dead code + legacy
5. Completeness

PASS CRITERIA (every box in plan 011 §14):

```
[ ] pnpm format --check exits 0
[ ] pnpm typecheck exits 0, zero hints
[ ] pnpm test exits 0 with ≥ 400 tests
[ ] pnpm --filter @vegastack/pages-web build clean
[ ] pnpm install + pnpm build (root) clean (CLI build no longer fails)
[ ] dist/server/entry.mjs total chunks reasonable
[ ] runtime.ts < 200 LOC
[ ] Zero references to: acquireRuntimeMutationLock, persistRuntimeState,
    hydrateRuntimeState, runtime_state, runtime_locks, ServiceError (legacy
    only — the new ServiceError in @vegastack/pages-services stays),
    attachEnvelope, SessionHandle, kv_namespaces, IMAGES binding,
    process.env.VPG_ADAPTER
[ ] Every service file is plain async functions over ServiceContext;
    no class singletons remaining in packages/core/src/*
[ ] packages/db/migrations/ contains exactly 0001_init.sql + 0002_oauth_seed.sql
[ ] No legacy column/table in 0001_init.sql (runtime_state, runtime_locks,
    render_cache_key, reanchor_status, redirect_uris_json all gone)
[ ] All JSON columns have CHECK (json_valid(x))
[ ] /p/[slug] cache hit returns in < 20ms p95 (sanity, in-test)
[ ] /p/[slug] cache miss does 1 D1 read + 1 R2 read + 0 render
[ ] view-permission publications emit no comments markup
[ ] comment/edit publications emit the lazy comments island
[ ] Cache invalidation on publish-time update within 5 seconds
[ ] Image upload compresses client-side (< 200 KB typical)
[ ] Page save renders to R2; concurrent saves of same page → 409
```

OPERATOR-SIDE (documented in `docs/operator-runbook.md`, NOT in this code change):

- Live KV namespaces deleted
- Live D1 truncated + new schema applied
- Live R2 retained; stale prefixes purged
- AWS SES sending domain verified
- Cloudflare Email Sending sending domain verified
- Required secrets set
- Sentry destination wired
- Zone rate limit rules configured

## 6. Risks + mitigations

| Risk                                                          | Severity   | Mitigation                                                                                                                                                                                  |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration filename change tricks D1 into half-applying schema | High       | Operator runbook explicitly drops live tables before `wrangler d1 migrations apply --remote`. Document the trap in docs/operator-runbook.md.                                                |
| Shiki bundle bloat                                            | Medium     | Use `@shikijs/engine-javascript` (regex-only, no oniguruma WASM). Lazy-load langs via `loadLanguage()` server-side on first use. Bundled langs: md/ts/js/json/bash/html/css/py/sql/rust/go. |
| Mermaid bundle in Worker                                      | Eliminated | Mermaid runs client-side in editor only. SVG inlined into source. Server never imports mermaid lib.                                                                                         |
| MDX `evaluate()` blocked by Workers eval ban                  | High       | Use `safe-mdx` pure-AST renderer with allowlist. No `new Function`, no `eval`.                                                                                                              |
| OffscreenCanvas WebP unsupported in Safari                    | Low        | Feature-detect; fall back to JPEG q=0.85 in Safari.                                                                                                                                         |
| Cache API ignores stale-while-revalidate                      | Low        | Compute SWR manually: stamp `customMetadata.cachedAt`, on read check age, refetch in waitUntil if stale.                                                                                    |
| AWS SES rate-limit on signup burst                            | Low        | SES default 14 emails/sec — well below our load. Document migration to dedicated IP at 1M/month threshold.                                                                                  |
| Live D1 schema rename trap (0001_initial.sql ≠ 0001_init.sql) | Critical   | Operator runbook MUST run `DROP TABLE` for every existing table before applying new schema. Don't trust `IF NOT EXISTS` to converge — it leaves stale schemas in place.                     |
| `runtime.ts` shrink breaks 60+ call sites at once             | High       | Phase B (route migration) is a prerequisite. Migrate consumers FIRST. After phase B, runtime.ts has no consumers; phase C is a near-mechanical delete.                                      |
| Astro v6 adapter auto-provisions SESSION KV binding           | Low        | We never call Astro.session. Build-time log is cosmetic. Document in CLAUDE.md so future contributors don't add a KV binding back.                                                          |

## 7. Commit boundary

Atomic commits per phase, prefixed `refactor:` / `feat:` / `chore:` per Conventional Commits + the project's commit-style rules. Suggested boundary:

```
1. chore(db): finalize 0001_init.sql; drop legacy cols + tables (Phase A)
2. refactor(web): migrate 40+ routes + libs to direct-D1 services (Phase B)
3. refactor(web): shrink runtime.ts to ~150 LOC; delete legacy services (Phase C)
4. refactor(web): shrink middleware.ts; delete runtime mutation lock (Phase D)
5. feat(renderer): save-time markdown/MDX/HTML pipeline (Phase E)
6. feat(services): publish fan-out + cache invalidation (Phase F)
7. feat(web): rewrite /p and /f for R2 artifact + Cache API (Phase G)
8. feat(web): image upload compression + R2 image proxy (Phase H)
9. chore(infra): final KV/IMAGES/session-driver cleanup (Phase I)
10. feat(email): AWS SES via aws4fetch primary; CF send_email fallback (Phase J)
11. feat(ops): /api/ready, scheduled handler, search reconciler (Phase K)
12. test: integration + render + public-read-path tests; 420+ total (Phase L)
13. docs: production-readiness audit + operator runbook (Phase M)
```

Pushing/tagging/deploying remains under the maintainer's explicit release approval per project CLAUDE.md.

## 8. Operator pre-deploy runbook (separate doc, written in Phase M)

`docs/operator-runbook.md` will spell out the destructive sequence per Plan 011 §2:

1. `wrangler whoami`
2. Inventory: `wrangler kv namespace list`, `wrangler r2 bucket list`, `wrangler d1 list`
3. Delete every Astro auto-provisioned KV namespace
4. `wrangler d1 execute vegastack-pages-db --remote --command "DROP TABLE …"` for every existing table
5. `wrangler d1 migrations apply vegastack-pages-db --remote`
6. (Optional) `wrangler r2 object delete` for stale `pub/*` keys
7. SES domain verification (DKIM CNAMEs + return-path)
8. Cloudflare Email Sending domain verification (cf-bounce subdomain)
9. `wrangler secret put AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/VPG_SETUP_TOKEN/ASTRO_KEY/VPG_GITHUB_APP_PRIVATE_KEY/…`
10. R2: PUT a `.healthcheck` object for `/api/ready`
11. Verify `wrangler deploy --dry-run` succeeds
12. **Maintainer-approved** `wrangler deploy`
13. `/api/health` and `/api/ready` → 200
14. Magic-link login → end-to-end via SES

## 9. Approval gate

This plan is local-only changes through Phase L. Phase M ends with a clean, deployable branch but **does NOT push, tag, publish, or deploy**. The release gate in CLAUDE.md applies — the maintainer issues the deploy command separately.

Awaiting maintainer's explicit "yes proceed" before starting Phase A.
