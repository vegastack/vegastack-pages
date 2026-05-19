# Plan 011 — Fresh clean-slate implementation

**Status:** Draft, awaiting approval.
**Supersedes:** Plan 010 (which is partially executed and superseded by this consolidation).
**Owner:** @mk
**Drafted:** 2026-05-17
**Constraints:**

- `pages.vegastack.com` is the live managed deploy. No production users.
- No backward compatibility. No legacy fallbacks. No "graceful migration." Truncate live D1, reset live R2 prefixes, deploy fresh.
- Final stack: **D1 + R2 + Workers + AWS SES**. Drop everything else.
- Cost target: < $20/month at 1,000 active users.

---

## 1. Architecture (final, locked)

```
                  Browser • MCP client • CLI
                            │ HTTPS
                            ▼
                pages.vegastack.com (CF DNS + WAF + Rate Limit Rules)
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ Single Cloudflare Worker (placement: smart, nodejs_compat)   │
   │   Astro 6.3 SSR · @astrojs/cloudflare 13.5 · custom worker.ts│
   │                                                              │
   │   Middleware: auth + CSRF + ACTIONS_RL + ALS-scoped D1 batch │
   │              + security headers (CSP, HSTS, X-Frame-Options) │
   │                                                              │
   │   Routes                                                     │
   │     /                marketing                               │
   │     /docs/*          prerendered docs                        │
   │     /p/[slug]        public page (R2 artifact + Cache API)   │
   │     /f/[slug]        public folder (R2 artifact + Cache API) │
   │     /img/[...key]    R2 image proxy (immutable cache)        │
   │     /api/*           REST API (direct-D1 services)           │
   │     /app/*           authenticated app (ClientRouter)        │
   │     /auth/* /oauth/* /mcp /.well-known/*                     │
   │     /api/health      liveness                                │
   │                                                              │
   │   Cron triggers: nightly GitHub backup + search reconciler   │
   └─────────┬──────────────┬────────────────────────┬────────────┘
             │              │                        │
             ▼              ▼                        ▼
        ┌────────┐     ┌──────────┐          ┌──────────────┐
        │   D1   │     │    R2    │          │   AWS SES    │
        │        │     │ CONTENT  │          │ (primary +   │
        │  ALL   │     │          │          │  CF send_    │
        │ tables │     │  - md/   │          │  email       │
        │ + FTS5 │     │    mdx/  │          │  fallback)   │
        │        │     │    html  │          └──────────────┘
        │        │     │  sources │
        │        │     │ - pub/   │
        │        │     │   {pubId}│
        │        │     │   /...   │
        │        │     │ - attach │
        │        │     │   ments  │
        │        │     │ - mermaid│
        │        │     │   svg    │
        │        │     └──────────┘
        └────────┘
```

**Removed bindings (live + code):**

- ❌ `kv_namespaces` (no Astro sessions, no slug→artifact map)
- ❌ `images` (Workers Images binding — using client-side compression + Astro `<Image />` instead)
- ❌ `send_email` declared as an additional fallback only (AWS SES is primary)

**Final bindings:**

- ✅ `d1_databases` — `DB`
- ✅ `r2_buckets` — `CONTENT`
- ✅ `ratelimits` — `ACTIONS_RL`
- ✅ `send_email` — `EMAIL` (one binding, fallback path only; AWS SES via HTTPS is primary)
- ✅ `assets` — `ASSETS` (Astro client bundle)

---

## 2. Production-infrastructure state

### Inventory commands (run before phase 3)

```sh
# Authenticate locally with the maintainer's CF account.
wrangler whoami

# What KV namespaces does the account own?
wrangler kv namespace list

# What R2 buckets?
wrangler r2 bucket list

# What D1 databases?
wrangler d1 list

# What Workers are deployed?
wrangler deployments list --name vegastack-pages

# Inspect the live D1 schema (sanity-check before truncation).
wrangler d1 execute <database_name> --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# Inspect any data rows that might exist:
wrangler d1 execute <database_name> --remote --command \
  "SELECT COUNT(*) FROM users;"
```

### Expected state after inventory

- D1 database: 1 (e.g. `vegastack-pages-db`)
- R2 bucket: 1 (e.g. `vegastack-pages-content`)
- KV namespaces: probably 1 or 2 (auto-created by Astro's session feature; we delete them)
- Worker: 1 (`vegastack-pages` on `pages.vegastack.com`)

### Cleanup commands (run during phase 3)

```sh
# Delete every KV namespace the project no longer needs.
# `wrangler kv namespace list` returns id+title; the maintainer copies
# any namespace that was created by the old Astro session config
# (default title is similar to "vegastack-pages-SESSION").
wrangler kv namespace delete --namespace-id <id>

# Drop the legacy tables from the live D1 (clean reset; no-users premise).
# DO NOT run on a database with real workspace data.
wrangler d1 execute vegastack-pages-db --remote --command \
  "DROP TABLE IF EXISTS runtime_state;
   DROP TABLE IF EXISTS runtime_locks;
   DROP TABLE IF EXISTS jobs;
   DROP TABLE IF EXISTS oauth_auth_codes;
   DROP TABLE IF EXISTS oauth_device_codes;"

# Confirmed-empty: drop EVERY table and re-apply the squashed schema.
wrangler d1 execute vegastack-pages-db --remote --command \
  "SELECT 'DROP TABLE IF EXISTS ' || name || ';' AS stmt
   FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
# pipe output back through `wrangler d1 execute --command "..."` to drop all.

# Apply the canonical squashed migration on the live D1.
wrangler d1 migrations apply vegastack-pages-db --remote

# Clean the R2 bucket of stale artifacts (keep the bucket, drop contents).
# DO NOT run if there's a chance of real user data — the no-users premise
# is what makes this safe.
wrangler r2 bucket list-objects vegastack-pages-content | \
  jq -r '.objects[].key' | \
  xargs -I{} wrangler r2 object delete vegastack-pages-content/{}

# (Optional) Set R2 lifecycle for the `pub/` prefix so old content-hash
# artifacts auto-purge after 90 days.
# Configured in the Cloudflare dashboard under R2 → bucket → Lifecycle.
```

The Worker itself stays — we redeploy after the new code lands. No rename, no DNS change, no blue-green. The deploy is the cutover.

---

## 3. Final D1 schema (`packages/db/migrations/0001_init.sql`)

Replaces the current squashed schema. **No legacy elements** — no `runtime_state`, no `runtime_locks`, no `pages.render_cache_key`, no `comment_anchors.reanchor_status`, no `agent_sessions.redirect_uris_json`. All `-- Legacy …` comments removed.

### Tables (final list)

1. `users` — id PK, email UNIQUE, display_name, role, ts
2. `auth_identities` — UNIQUE(provider, provider_subject); idx(user_id)
3. `auth_sessions` — idx(user_id), idx(expires_at) for sweep
4. `magic_links` — UNIQUE(token_hash), idx(email), idx(expires_at)
5. `workspaces` — UNIQUE(slug), `version_retention_days`
6. `workspace_members` — UNIQUE(workspace_id, user_id); idx(user_id)
7. `permissions` — UNIQUE(workspace_id, subject_type, subject_id, scope, target_id); idx(workspace_id, subject_id)
8. `folders` — `parent_folder_id REFERENCES folders(id) ON DELETE CASCADE`; UNIQUE(slug_id); idx(workspace_id, parent_folder_id, position)
9. `pages`
   - Standard cols + `version_id`
   - **New: render flags** `has_code INT`, `has_mermaid INT`, `has_math INT`, `has_wardley INT`, `has_cytoscape INT`, `has_iframe INT`
   - **New: rendered artifact** `rendered_artifact_key TEXT` (R2 key of the latest baked HTML; null for unpublished pages or stale renders)
   - **New: source_type** now accepts `'markdown' | 'mdx' | 'html'` (existing CHECK constraint already supports these)
   - idx(workspace_id, folder_id, position) WHERE deleted_at IS NULL
   - idx(workspace_id, updated_at DESC) WHERE deleted_at IS NULL
10. `page_versions` — idx(page_id, created_at DESC)
11. `page_favorites` — composite PK (user_id, page_id); idx(user_id, workspace_id, created_at DESC); idx(page_id)
12. `workspace_templates`, `workspace_template_versions`
13. `comment_threads` — idx(page_id, status, created_at DESC); idx(publication_id) WHERE NOT NULL
14. `comment_anchors` — all metadata cols folded in
15. `comment_replies` — idx(thread_id, created_at)
16. `publications`
    - Standard cols
    - **New: `latest_artifact_key TEXT`** — R2 key of the latest baked HTML for this publication
    - **New: `latest_content_hash TEXT`** — convenience copy of the page's content_hash at publish time
    - **New: `latest_rendered_at TEXT`** — when the artifact was rebuilt
    - UNIQUE(workspace_id, resource_type, resource_id); idx(resource_type, resource_id)
17. `attachments`
    - Standard cols (object_key, content_type, byte_size)
    - **New: `image_width INT`, `image_height INT`** — populated client-side at upload time when the file is an image. Used to emit `<img width=...>` markup for CLS-free rendering.
    - idx(page_id); idx(workspace_id)
18. `audit_logs` — idx(workspace_id, created_at DESC)
19. `review_events` — idx(workspace_id, created_at DESC); idx(page_id)
20. `search_documents` — composite PK; idx(workspace_id, resource_type, updated_at DESC)
21. `search_documents_fts` — FTS5 + AFTER INSERT/UPDATE/DELETE triggers
22. `search_recent_resources` — composite PK; idx(user_id, workspace_id, last_opened_at DESC)
23. `setup_state` — single-row
24. `rate_limits` — idx(reset_at)
25. `agent_sessions` — merged shape, no `redirect_uris_json`
26. `mcp_sessions` — UNIQUE partial idx(refresh_token_hash) WHERE NOT NULL
27. `oauth_clients`
28. `oauth_grants` — merged shape with CHECK constraints
29. `github_sync_connections` — UNIQUE(workspace_id); idx(installation_id)
30. `github_sync_runs` — idx(connection_id, started_at DESC)
31. `schema_migrations` — `filename PK, applied_at`

JSON columns get `CHECK (json_valid(x))`.

### Seeds (`packages/db/migrations/0002_oauth_seed.sql`)

- `INSERT OR IGNORE` for `oac_vpg_cli` + `oac_anthropic_connector` well-known OAuth clients.

---

## 4. Code deletions (no legacy fallbacks)

### Whole files / directories

```
apps/web/src/lib/runtime.ts             — SHRINK (see §4.1)
apps/web/src/lib/runtime/repos/          — DELETE WHOLE DIR (legacy in-memory adapters)
packages/core/src/page-service.ts        — DELETE (becomes packages/services/src/pages.service.ts D1-direct)
packages/core/src/workspaces.ts          — DELETE (→ workspaces.service.ts)
packages/core/src/comments.ts            — DELETE (→ comments.service.ts)
packages/core/src/auth.ts                — DELETE (→ auth.service.ts)
packages/core/src/publications.ts        — DELETE (→ publications.service.ts)
packages/core/src/access-control.ts      — DELETE (→ permissions.service.ts)
packages/core/src/attachments.ts         — DELETE (→ attachments.service.ts)
packages/core/src/favorites.ts           — DELETE (→ favorites.service.ts)
packages/core/src/audit.ts               — DELETE (→ audit.service.ts)
packages/core/src/review-events.ts       — DELETE (→ review-events.service.ts)
packages/core/src/search.ts              — DELETE (→ search.service.ts)
packages/core/src/template-service.ts    — DELETE (→ templates.service.ts)
packages/core/src/rate-limit.ts          — DELETE (→ rate-limit.service.ts)
packages/core/src/setup.ts               — DELETE (→ setup.service.ts)
packages/core/src/object-store.ts        — KEEP (R2 + Node FS facade; thin)
packages/core/src/permissions.ts         — KEEP (pure permission-resolution logic)
packages/core/src/anchors.ts             — KEEP (pure anchor coercion)
packages/core/src/ids.ts                 — KEEP (id prefixes + slug helpers)
packages/core/src/errors.ts              — KEEP (AppError)
packages/core/src/events.ts              — DELETE if unused (verify)
docs/audits/2026-05-17-production-readiness.md  — KEEP (historical record)
docs/plans/010-clean-slate-rebuild.md    — DELETE (superseded by this plan)
```

### Sections inside `runtime.ts` to delete (~1,650 LOC → ~150 LOC)

- `RuntimeSnapshot` type + every snapshot helper
- `createRuntimeSnapshot`, `restoreRuntimeSnapshot`, every `mapEntries`/`restoreMap`/`serviceMapValues` helper
- `hydrateRuntimeState`, `hydrateNormalizedRuntimeState`, `ensureRuntimeReady`, `refreshRuntimeState`, `rebuildSearchIndexFromRuntime`
- `acquireRuntimeMutationLock`, `persistRuntimeState`, `persistNormalizedRuntimeState{,Batch}`, `deleteNormalizedRuntimeState`
- `hydrateNodeState`, `persistNodeState` (no on-disk JSON snapshot)
- All service singletons (`pageService`, `workspaceService`, …) — replaced by `packages/services/*.service.ts`
- The hand-rolled `CREATE TABLE IF NOT EXISTS` bootstrap block — migrations are the only source of truth
- `normalizeCommentAnchorRecord` + helpers (legacy rect→point migration)
- `legacyMcpSessionListId`, `maskListedMcpSession`, `resolveStoredMcpSessionId`
- `fallbackMcpSessions`, `fallbackRefreshIndex` Maps
- `runtimeHydratedFromNormalizedTables` dead variable

### What `runtime.ts` becomes (~150 LOC)

```ts
// Cloudflare/Node-binding plumbing only.
export type CloudflareBindings = { … };          // typed env
export async function getRuntimeBindings(): Promise<CloudflareBindings | null>;
export async function getDb(): Promise<D1Database>;
export async function getObjectStore(): Promise<ObjectStore>;
export { d1All, d1Run, d1Batch, boolFromDb, jsonFromDb, jsonToDb };
export { sha256Hex } from "./crypto";
export function isNodeRuntime(): boolean;
// Node-only adapter dynamic-loaded; never imported into the CF bundle.
```

### Middleware reduces to

```ts
export const onRequest = defineMiddleware(async (ctx, next) => {
  setCloudflareWaitUntil((p) => ctx.locals.cfContext.waitUntil(p));
  ctx.locals.actor = await resolveActor(ctx); // 1 D1 read (session lookup)
  if (isUnsafeMethod(ctx.request) && !isOauthOrMcp(ctx.url.pathname)) {
    assertCsrf(ctx);
  }
  if (ctx.url.pathname.startsWith("/_actions/") && ctx.locals.actor.userId) {
    await assertActionRateLimit(ctx); // ACTIONS_RL binding
  }
  const response = await next();
  if (response.headers.get("content-type")?.startsWith("text/html")) {
    applySecurityHeaders(response, ctx.url);
  }
  return response;
});
```

No mutation lock. No runtime hydration. No persist call. Each route is responsible for its own atomicity via `d1Batch([…])` and per-row D1 writes.

### Other deletions

- `apps/web/src/lib/__tests__/*` — the in-memory service tests; rewritten as service-level direct-D1 tests
- `apps/web/src/lib/middleware-policy.ts` — `bypassesRuntimePersistence` no longer needed; bypass list collapses to `isOauthOrMcp` predicate inside middleware
- `astro.config.mjs` Astro-session config — set explicitly to disable so the adapter doesn't auto-claim KV
- Wrangler `kv_namespaces`, `images` blocks — removed
- `.env.example` — drop every env var no service reads after the rewrite (sweep)

---

## 5. Service rewrites (direct-D1, ordered)

Each service in `packages/services/src/*.service.ts` exports plain async functions over `ServiceContext`. No singletons. No in-memory Maps. Every read is a parameterised D1 query; every multi-step write is a `db.batch([...])`.

### Order of migration

Easiest → hardest. Each is independently shippable.

| #   | Service                                           | Surface                             | Notes                                                                                                     |
| --- | ------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | `setup.service.ts`                                | single-row `setup_state`            | trivial                                                                                                   |
| 2   | `rate-limit.service.ts`                           | atomic UPSERT                       | already mostly direct-D1; clean up                                                                        |
| 3   | `auth.service.ts`                                 | sessions, magic links, identities   | magic-link consume → atomic `UPDATE … WHERE consumed_at IS NULL RETURNING …`                              |
| 4   | `users.service.ts` (split out of workspaces)      | users + auth_identities             | INSERT-OR-IGNORE on email                                                                                 |
| 5   | `audit.service.ts`                                | append-only                         | one INSERT per call                                                                                       |
| 6   | `review-events.service.ts`                        | append-only                         | same                                                                                                      |
| 7   | `favorites.service.ts`                            | INSERT OR IGNORE + DELETE           | composite key                                                                                             |
| 8   | `attachments.service.ts`                          | per-page                            | single-table; image_width/height stored from client                                                       |
| 9   | `permissions.service.ts`                          | grants                              | per-row CRUD; the resolution logic in `packages/core/src/permissions.ts` stays pure                       |
| 10  | `comments.service.ts`                             | threads + anchors + replies         | batch the thread+anchor INSERT; reply is a single INSERT                                                  |
| 11  | `publications.service.ts`                         | publish/unpublish + verify password | includes the publish fan-out hook (see §7)                                                                |
| 12  | `workspaces.service.ts`                           | workspaces + members                | medium                                                                                                    |
| 13  | `folders.service.ts`                              | tree with path rebuild              | hardest — moving a folder needs a batched UPDATE over descendants                                         |
| 14  | `pages.service.ts`                                | pages + page_versions               | optimistic concurrency on `version_id`; updateSource also pushes new artifact key when publication exists |
| 15  | `templates.service.ts`                            | workspace_templates + versions      | similar to pages                                                                                          |
| 16  | `search.service.ts`                               | indexer hooks + FTS5 query          | reconciler cron rebuilds from base tables                                                                 |
| 17  | `mcp-sessions.service.ts` (split from runtime.ts) | token rotation already in d1Batch   | mostly cleanup                                                                                            |

### Service-method signature contract

```ts
import { AppError } from "@vegastack/pages-core";
import type { ServiceContext } from "./context";

export async function move(
  ctx: ServiceContext,
  args: { pageId: string; folderId: string | null; position?: number },
): Promise<{ page: PageRecord; envelope: MutationEnvelope }> {
  const page = await ctx.db
    .prepare(
      "SELECT id, workspace_id, folder_id, title, slug_id, content_hash, updated_at FROM pages WHERE id = ?1 AND deleted_at IS NULL",
    )
    .bind(args.pageId)
    .first<PageRow>();
  if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);

  // Permission check happens at the route layer (existing pattern).

  const now = new Date().toISOString();
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE pages SET folder_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
      )
      .bind(args.folderId, args.position ?? null, now, args.pageId),
    ctx.db
      .prepare(
        "INSERT INTO audit_logs (id, workspace_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?1, ?2, ?3, 'page.move', 'page', ?4, ?5, ?6)",
      )
      .bind(
        newId("aud"),
        page.workspace_id,
        ctx.actor.userId,
        args.pageId,
        JSON.stringify({ from: page.folder_id, to: args.folderId }),
        now,
      ),
  ]);

  ctx.waitUntil(scheduleIndexPage(ctx, args.pageId));
  ctx.waitUntil(invalidatePublicationCache(ctx, args.pageId));

  const fresh = await get(ctx, {
    workspaceId: page.workspace_id,
    pageId: args.pageId,
  });
  return {
    page: fresh,
    envelope: await buildEnvelope(ctx, page.workspace_id, [
      `page:${args.pageId}`,
    ]),
  };
}
```

Notes:

- `ctx.db` is the canonical D1 handle. `ctx.actor` is the resolved request actor. `ctx.waitUntil` forwards to the runtime's `ctx.waitUntil`.
- `newId("aud")` lives in `packages/core/src/ids.ts`.
- `buildEnvelope` reads the post-mutation `tree_version` via a single workspace navigation query.

### Authorization contract

Services validate authentication (`ctx.actor.userId` present). They do **not** enforce per-resource authorization — routes call `permissions.assert(...)` BEFORE invoking a service mutation. Same contract we had before, just consolidated.

### Per-service test target

Each service ships with `packages/services/src/__tests__/<service>.test.ts` running against an in-memory `better-sqlite3` D1 with `0001_init.sql` applied. Tests cover:

- Happy path (returns expected shape, envelope correct)
- Authentication-denied (anonymous → `AUTH_REQUIRED`)
- Not-found (`ENTITY_NOT_FOUND`)
- Concurrency (two parallel writes → both atomic, no orphan rows)
- Idempotency where applicable (re-add favorite is a no-op)

Target: **400+ test count** across the rewrite (current is 321).

---

## 6. Save-time rendering pipeline

Move every render off the request path. The HTML in R2 is fully self-contained: Shiki syntax highlighting baked in, KaTeX math rendered to spans, mermaid SVGs inlined.

### `pages.service.ts.updateSource` flow

1. Validate the source (size limit, syntax allowed for source_type).
2. SHA256 the source → `content_hash`.
3. PUT source to R2 at `pages/{workspaceId}/{pageId}/source-{content_hash}.{md|mdx|html}`.
4. Walk the AST to populate render flags (`has_code`, `has_mermaid`, `has_math`, `has_wardley`, `has_cytoscape`, `has_iframe`).
5. Render to final HTML using the pipeline below.
6. PUT rendered HTML to R2 at `pages/{workspaceId}/{pageId}/rendered-{content_hash}.html`.
7. UPDATE `pages` row: `content_hash`, `object_key_current`, `rendered_artifact_key`, version cols, all has\_\* flags. Atomic in `db.batch`.
8. If the page has a publication: trigger the **publish fan-out** (§7).
9. `ctx.waitUntil(scheduleIndexPage(ctx, pageId))` — search index re-build.

### Render pipeline

````
source (md / mdx / html)
   │
   ▼
[remark]  remarkParse → remarkGfm → custom mermaid plugin
   │      └─ mermaid plugin renders each ```mermaid block to SVG
   │         via the @mermaid-js/mermaid library + linkedom DOM
   │         polyfill (runs in Workers). SVG inlined into AST.
   ▼
[remarkRehype]  no allowDangerousHtml — raw HTML is dropped here
   │      EXCEPT for source_type === "html" which uses a separate
   │      sanitize-then-iframe pipeline (not remark).
   ▼
[rehype] rehype-shiki (syntax-highlight; only when has_code)
   │     rehype-katex (math; only when has_math)
   │     rehype-sanitize (always — final guard)
   │     rehype-stringify
   ▼
final HTML string → R2
````

- **MDX**: same pipeline as markdown plus the MDX-JSX evaluator. Only an allowlisted set of components (`<Callout>`, `<Tabs>`, `<Steps>`) is permitted; everything else is dropped by `rehype-sanitize`.
- **HTML**: bypass remark. Sanitize via `rehype-sanitize` with a stricter allowlist. Wrap in a `<iframe sandbox="allow-scripts">` at view time (same as today's `/p/[slugId].astro:1213`).
- **Mermaid**: server-rendered to SVG at save time. The mermaid lib + linkedom add ~500KB to the Worker bundle — confirmed under the 10MB limit. SVGs cached in R2 by `sha256(mermaid_source)` so identical diagrams across pages dedupe.
- **Shiki**: use `shiki/core` with explicit `bundledLanguages` (markdown, ts, js, json, bash, html, css, py, sql, rust, go, java, kotlin, swift). Lazy-load other languages on first use via `shiki.loadLanguage()` server-side.

### Cost characteristics

- Render runs **once per save** on the authoring path. Public reads never render.
- Worker CPU per save: ~50-200ms for a typical page (~5KB markdown, 1-2 code blocks, 0-1 mermaid).
- R2 storage per page: source (~5KB) + rendered (~15-30KB) + ~1KB per mermaid SVG. ~50KB/page total.
- For a workspace with 1,000 pages: 50MB of R2. Negligible.

---

## 7. Publish fan-out

Triggered by:

- `pages.service.ts.updateSource` when the page has a publication.
- `publications.service.ts.upsert` when a new publication is created or its config changes.

### Flow

```ts
async function publishFanOut(ctx, { publicationId, pageId, contentHash }) {
  const renderedKey = `pages/${workspaceId}/${pageId}/rendered-${contentHash}.html`;
  const publicKey = `pub/${publicationId}/${contentHash}.html`;

  // 1. Copy rendered HTML to the public path (or write directly here
  //    if the page-render step writes only to the per-page location).
  const rendered = await ctx.objectStore.get(renderedKey);
  if (!rendered)
    throw new AppError("RENDER_ERROR", "Rendered artifact missing.", 500);
  await ctx.objectStore.put(publicKey, rendered.body, {
    contentType: "text/html; charset=utf-8",
    contentLanguage: page.language ?? "en",
    customMetadata: { content_hash: contentHash, page_id: pageId },
  });

  // 2. Update the publication row — single source of truth for the
  //    public read path's slug → artifact mapping.
  await ctx.db
    .prepare(
      `
    UPDATE publications
    SET latest_artifact_key = ?1,
        latest_content_hash = ?2,
        latest_rendered_at  = ?3,
        updated_at          = ?3
    WHERE id = ?4
  `,
    )
    .bind(publicKey, contentHash, new Date().toISOString(), publicationId)
    .run();

  // 3. Invalidate the Cloudflare edge cache for the public URL.
  const slug = publication.slug; // already on the publication row
  ctx.waitUntil(
    caches.default.delete(
      new Request(`${publicOrigin}/p/${slug}`, { method: "GET" }),
    ),
  );
  if (publication.resourceType === "folder") {
    ctx.waitUntil(
      caches.default.delete(
        new Request(`${publicOrigin}/f/${slug}`, { method: "GET" }),
      ),
    );
  }
}
```

### Why no KV

The slug → artifact-key map lives in the `publications` row. Reading it costs **one D1 SELECT** by indexed column. KV would cost one KV read with up to 60s of cross-region lag. D1 in-colo reads are ~5ms and immediately consistent. No KV.

### Old artifacts

Content-hashed keys mean old versions stay in R2 forever (or until lifecycle policy purges them). Cheap to keep — page versions in R2 are exactly the version history. Optional R2 lifecycle rule: purge `pub/*/<hash>.html` older than 90 days where the hash is not `publications.latest_content_hash`. Configured in the CF dashboard.

---

## 8. Public read path

`/p/[slug].astro` and `/f/[slug].astro`:

```astro
---
const cacheKey = new Request(Astro.url.toString(), Astro.request);
const cached = await caches.default.match(cacheKey);
if (cached) return cached;

// One D1 lookup: slug → publication row (with latest_artifact_key + access policy).
const publication = await publications.findBySlug(ctx, Astro.params.slug);
if (!publication || publication.revokedAt) {
  return new Response("Not found", { status: 404 });
}

// Access enforcement.
if (publication.passwordHash) {
  if (!(await verifyPasswordCookie(ctx, publication))) {
    return passwordPromptResponse(/* astro, publication */);
  }
}
if (
  publication.permission === "view" &&
  publication.indexingEnabled === false
) {
  Astro.response.headers.set("X-Robots-Tag", "noindex, nofollow");
}

// One R2 fetch: the baked HTML.
const artifact = await ctx.objectStore.get(publication.latestArtifactKey);
if (!artifact) {
  // Race: publication exists but artifact wasn't written yet. Re-render
  // on demand and continue (rare; should never happen post-fan-out).
  await republishOnDemand(ctx, publication);
  // …
}

// Comments gating happens client-side: we emit a tiny <CommentsIsland>
// only when permission allows it. View-only publications get no comments
// markup at all.
const showComments =
  publication.permission === "comment" || publication.permission === "edit";

const etag = `W/"${publication.latestContentHash}.${Date.parse(publication.latestRenderedAt).toString(36)}"`;
const ifNoneMatch = Astro.request.headers.get("If-None-Match");
const cacheControl = computeCacheControl(publication);

if (ifNoneMatch === etag) {
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, "Cache-Control": cacheControl },
  });
}

const response = new Response(
  buildShellHTML({
    artifact: await artifact.text(),
    publication,
    showComments,
  }),
  {
    headers: {
      "content-type": "text/html; charset=utf-8",
      etag: etag,
      "cache-control": cacheControl,
      ...(publication.passwordHash ? { vary: "Cookie" } : {}),
    },
  },
);

Astro.locals.cfContext.waitUntil(
  caches.default.put(cacheKey, response.clone()),
);
return response;
---
```

### Cache-Control matrix

| Publication state                    | Cache-Control                                                    | Vary     |
| ------------------------------------ | ---------------------------------------------------------------- | -------- |
| Indexable + password-free            | `public, max-age=300, s-maxage=86400, stale-while-revalidate=60` | —        |
| Link-only + password-free            | `public, max-age=60, s-maxage=300, stale-while-revalidate=60`    | —        |
| Password-gated                       | `private, max-age=60`                                            | `Cookie` |
| Member-only (`view` w/o publication) | `private, no-store`                                              | —        |

### Comments island (lazy)

```astro
{
  showComments && (
    <comments-island
      workspace-id={publication.workspaceId}
      publication-id={publication.id}
      page-id={publication.resourceId}
      permission={publication.permission}
    />
  )
}
```

`<comments-island>` is a custom element registered via `client:visible`. On viewport-enter, it fetches `/api/comment-threads?page_id=...&publication_id=...` — one D1 query — and renders the thread list. View-only publications never emit the element, so they never make the call.

---

## 9. Image handling (zero extra service cost)

### UI chrome — Astro `<Image />` at build time

`apps/web/src/assets/` contains logos, illustrations, icons used in the marketing pages and the app shell.

```astro
---
import logo from "../assets/logo.svg";
import { Image } from "astro:assets";
---

<Image src={logo} alt="VegaStack" width={32} height={32} />
```

Astro's build pipeline emits AVIF + WebP + fallback PNG/JPEG variants with hashed filenames into `_astro/`. Served via `ASSETS` binding from R2. No runtime CPU.

### User uploads — client-side compression

`apps/web/src/scripts/upload-image.ts` (new):

```ts
export async function compressBeforeUpload(file: File): Promise<{
  webp: Blob;
  width: number;
  height: number;
}> {
  const bitmap = await createImageBitmap(file);
  const targetWidth = Math.min(bitmap.width, 2000);
  const targetHeight = Math.round(bitmap.height * (targetWidth / bitmap.width));
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable.");
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  const webp = await canvas.convertToBlob({
    type: "image/webp",
    quality: 0.85,
  });
  return { webp, width: targetWidth, height: targetHeight };
}
```

Wired into the editor's drop/paste handler. On upload POST:

- Body: the WebP blob
- Headers: `X-Image-Width`, `X-Image-Height` (the client measured them)
- `/api/pages/[pageId]/attachments` stores blob in R2 at `attachments/{workspaceId}/{sha256(blob)}.webp` and writes the attachments row with `image_width`/`image_height`.

For non-image attachments: stored as-is, no compression.

### Image serving route

`apps/web/src/pages/img/[...key].ts` (new):

```ts
export const GET: APIRoute = async ({ params, request }) => {
  const key = (params.key as string[]).join("/");
  if (!key.startsWith("attachments/")) {
    return new Response("Not found", { status: 404 });
  }

  const cacheKey = new Request(request.url, request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const obj = await (await getObjectStore()).get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "content-type": obj.contentType ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    etag: obj.etag ?? `"${obj.key}"`,
  });
  const response = new Response(obj.body, { headers });
  Astro.locals.cfContext.waitUntil(
    caches.default.put(cacheKey, response.clone()),
  );
  return response;
};
```

Content-hashed keys make these safe to cache for a year. Cache API holds them at the edge.

### SVGs

Stored as text in R2 (under attachments or inline in markdown). At save time, `rehype-sanitize` validates the SVG element set. Inline-embedded into the rendered HTML.

### Mermaid

Server-rendered at save time as described in §6. Cached in R2 by `sha256(mermaid_source)` so identical diagrams across pages dedupe automatically.

### Removed bindings

- `images` block in `wrangler.jsonc` → removed
- `IMAGES` binding type in `CloudflareBindings` → removed
- `imageService.runtime: "cloudflare-binding"` in `astro.config.mjs` → reverted to `"passthrough"` (we don't use `<Image />` for user content; only for build-time chrome)

---

## 10. Operations + observability

### Email

`VPG_EMAIL_PROVIDER=auto` (default) picks **AWS SES** when `AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are set. Falls back to **Cloudflare `send_email` binding** when only `EMAIL` is bound. Falls back to dev/console otherwise.

Pre-deploy operator tasks:

- Verify the sending domain in AWS SES (DKIM CNAMEs + return-path).
- Verify the same domain in Cloudflare Email Sending (separate DKIM under `cf-bounce`).
- `wrangler secret put AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

### Cron triggers (`wrangler.jsonc` → `triggers.crons`)

- `"0 3 * * *"` — nightly GitHub backup (existing `runDueGitHubBackupSyncs`, sweeps ALL pages in every workspace, mirrors to the configured GitHub backup repo in organized folder structure).
- `"30 3 * * *"` — nightly **search index reconciler**: re-derives `search_documents` + FTS5 entries from base tables (pages, folders, comment_threads). Heals any background-task drop that might have left search stale.

### Observability

`wrangler.jsonc` `observability`:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "enabled": true, "head_sampling_rate": 1, "invocation_logs": true }
}
```

Tracing → Sentry via OTLP is configured in the Cloudflare dashboard (Workers → Observability → Destinations). Code emits structured JSON logs:

- `vpg.cron.completed`, `vpg.cron.failed`
- `vpg.publish.completed` `{ publication_id, content_hash, duration_ms }`
- `vpg.render.failed` `{ page_id, source_type, error }`
- `vpg.background.failed` `{ task, error }`
- `vpg.image.served` `{ key, cache_hit, byte_size }` (sampled at 1%)

### Health endpoint

`/api/health` already exists. Add a deeper readiness probe at `/api/ready` that does:

1. `SELECT 1` against D1
2. `HEAD` against a known R2 object (a small `.healthcheck` blob we keep in the bucket)
3. AWS SES `GetSendQuota` (optional; toggled via env)

Returns 200 only if all three pass.

### Rate limiting

`ACTIONS_RL` binding (per-user Astro Action limits). Plus CF dashboard zone rate limit rules:

- `/api/auth/*` — 30 req/min/IP
- `/p/*`, `/f/*` — 600 req/min/IP (public; mostly cache-served)
- `/oauth/*`, `/mcp` — 120 req/min/IP

---

## 11. Final `apps/web/wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "vegastack-pages",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-05-14",
  "compatibility_flags": ["nodejs_compat"],
  "placement": { "mode": "smart" },
  "workers_dev": false,
  "routes": [{ "pattern": "pages.vegastack.com", "custom_domain": true }],

  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
  },

  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true,
      "head_sampling_rate": 1,
      "invocation_logs": true,
    },
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "vegastack-pages-db",
      "database_id": "<live-id-from-CF-account>",
      "migrations_dir": "../../packages/db/migrations",
    },
  ],

  "r2_buckets": [
    {
      "binding": "CONTENT",
      "bucket_name": "vegastack-pages-content",
    },
  ],

  "ratelimits": [
    {
      "name": "ACTIONS_RL",
      "namespace_id": "1001",
      "simple": { "limit": 60, "period": 60 },
    },
  ],

  "send_email": [
    {
      "name": "EMAIL",
      "allowed_sender_addresses": ["login@pages.vegastack.com"],
    },
  ],

  "triggers": {
    "crons": ["0 3 * * *", "30 3 * * *"],
  },

  "vars": {
    "VPG_RUNTIME": "cloudflare",
    "VPG_DEPLOYMENT_MODE": "managed",
    "VPG_PUBLIC_SIGNUP": "true",
    "VPG_HOME_MODE": "landing",
    "VPG_BASE_URL": "https://pages.vegastack.com",
    "VPG_EMAIL_FROM": "login@pages.vegastack.com",
    "VPG_EMAIL_FROM_NAME": "VegaStack Pages",
    "VPG_EMAIL_PROVIDER": "auto",
  },
}
```

**No** `kv_namespaces`. **No** `images`. **No** `durable_objects`.

### Astro session config

```js
// astro.config.mjs
adapter: cloudflare({
  imageService: { build: "compile", runtime: "passthrough" },
  prerenderEnvironment: "node",
  // Explicitly disable the auto-injected SESSION KV binding —
  // we use D1-backed auth_sessions, not Astro.session.
  sessionKVBindingName: false,
}),
```

(Adapter API: confirm with `cloudflare.mdx` lines on session config — falls back to a no-op if the option isn't supported in v13.)

---

## 12. Test plan

### Per-phase tests (added alongside the code)

| Phase                  | Tests added                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1: setup.service | 4 — happy path, already-complete reject, missing token, atomic flip                                                                                      |
| Phase 2: rate-limit    | 3 — under limit, exact limit, over limit                                                                                                                 |
| Phase 3: auth.service  | 8 — create magic link, atomic consume (concurrent), expired link, session destroy, session get                                                           |
| Phase 4: users         | 4 — create new, idempotent on email, role checks                                                                                                         |
| Phase 5: audit         | 2 — append + list                                                                                                                                        |
| Phase 6: review-events | 2 — append + list                                                                                                                                        |
| Phase 7: favorites     | 4 — add, idempotent re-add, remove, list-for-user                                                                                                        |
| Phase 8: attachments   | 5 — upload, image with dimensions, non-image, list, delete                                                                                               |
| Phase 9: permissions   | 6 — grant, revoke, resolve, member vs grant precedence, instance admin override                                                                          |
| Phase 10: comments     | 8 — create thread + anchor (batched), reply, anchor update, resolve, delete cascade, stats                                                               |
| Phase 11: publications | 6 — upsert, publish fan-out triggers (mocked R2), revoke clears cache, password verify                                                                   |
| Phase 12: workspaces   | 5 — create, member add/remove, list-for-user, instance-admin visibility                                                                                  |
| Phase 13: folders      | 6 — create, move (path rebuild batched), reorder, delete cascade                                                                                         |
| Phase 14: pages        | 10 — create, update source (with re-render + publish fan-out), move, version list, restore version, concurrent updateSource race (409), MDX, HTML source |
| Phase 15: templates    | 5 — create, version, render to page, list, delete                                                                                                        |
| Phase 16: search       | 4 — index page, query, FTS trigger sync, reconciler                                                                                                      |
| Phase 17: mcp-sessions | 4 — create, rotate (atomic), revoke (atomic), refresh expiry                                                                                             |

**Total target: 400+ tests** (up from 321).

### Integration tests (cross-service)

`apps/web/src/pages/api/_tests/`:

- Magic-link request → email logged → verify → session cookie set → /app loads
- Setup flow → admin created → first workspace created → seed pages exist
- OAuth full flow (already covered, verify still passes)
- MCP create-page → publish → read /p/ as anonymous → cache hit on second request
- Comment thread on a `view`-permission publication → expect 404 (or 403)
- Comment thread on a `comment`-permission publication → 200 + thread
- Page-source update on a published page → /p/ artifact updates, cache invalidates

### Render-pipeline tests

`packages/renderer/src/__tests__/render-pipeline.test.ts`:

- Markdown with code → has_code=1, Shiki classes in HTML
- Markdown with math → has_math=1, KaTeX classes in HTML
- Markdown with mermaid → has_mermaid=1, inline SVG in HTML
- Markdown with all features → all flags + full pipeline
- MDX with allowed components → renders
- MDX with disallowed JSX → sanitized out
- HTML source → wrapped in sandboxed iframe markup
- Malicious `<script>` → stripped

### Performance tests (informational only)

Run via `oha` against local Node backend:

- 100 concurrent page reads (same slug) → all served from in-memory render cache
- 50 concurrent page saves (different pages) → all succeed; no D1 contention
- 50 concurrent page saves (same page) → optimistic concurrency, exactly one succeeds + 49 get 409

### Final audit pass

Re-run the 5-parallel-agent audit identical to plan 011 §11's earlier run:

1. Reliability + concurrency
2. Security
3. Consistency + pattern coherence
4. Dead code + legacy
5. Completeness

Pass criteria: **zero BLOCKER, zero HIGH unresolved**.

### Browser smoke (manual)

After all phases:

1. Cold-load `/`, `/docs`, `/app`, `/p/<slug>`. Lighthouse ≥ 90.
2. Save a page in `/app`. Verify the public `/p/<slug>` updates within 5 seconds.
3. Upload an image — verify it compresses client-side, the upload is small, `/img/<key>` serves it.
4. Create a mermaid diagram in markdown — verify it renders as inline SVG on the public page.
5. Comment on a `comment`-permission publication. Verify thread visible.
6. Comment on a `view`-permission publication. Verify no comments UI present.
7. MDX page with `<Callout>`. Verify renders.
8. HTML page. Verify sandboxed iframe.
9. Magic-link login. Verify SES delivers (or console-logs in dev).
10. MCP tool call from Claude → page created in workspace → visible immediately in `/app`.

---

## 13. Execution order (12 working days)

### Day 1 — Infrastructure inventory + cleanup

- Run all `wrangler kv namespace list`, `r2 bucket list`, `d1 list` inventory commands.
- Save output to `/docs/audits/2026-05-XX-live-infra-inventory.md`.
- Identify the unused KV namespaces; delete them.
- Drop legacy tables from live D1 (no-users premise allows this).
- Confirm the live wrangler config (read `apps/web/wrangler.jsonc` already-committed canonical config — substitute the live `database_id`).

### Day 2 — Schema + db package

- Write the final `0001_init.sql` (this plan's §3).
- Delete the live D1's tables, apply the new schema via `wrangler d1 migrations apply --remote`.
- Update `packages/db/src/types.ts` to match the final shape.
- Tests: schema-shape sanity test (every CREATE TABLE in 0001_init.sql is queryable).

### Day 3 — Code deletions

- Delete files in §4 (whole files).
- Shrink `runtime.ts` per §4.
- Shrink `middleware.ts` per §4.
- Delete `packages/core/src/*-service.ts` files (their D1-direct replacements arrive in days 4-9).
- Update `astro.config.mjs` to disable session KV; remove `images` binding from `wrangler.jsonc`.
- Run `pnpm typecheck` — expect MANY errors (services are gone). That's the work for days 4-9.

### Day 4 — Direct-D1 services part 1

Phases 1-6 from §5: setup, rate-limit, auth, users, audit, review-events.

Each ships with its test file. Routes that call these services get updated to import from `@vegastack/pages-services`.

### Day 5 — Direct-D1 services part 2

Phases 7-10: favorites, attachments, permissions, comments.

### Day 6 — Direct-D1 services part 3

Phases 11-12: publications, workspaces.

### Day 7 — Direct-D1 services part 4 (the hard ones)

Phases 13-14: folders (path rebuild), pages (optimistic concurrency).

### Day 8 — Direct-D1 services part 5

Phases 15-17: templates, search, mcp-sessions.

End of day 8: `pnpm typecheck` clean. `pnpm test` passes with 400+ tests.

### Day 9 — Save-time rendering pipeline

- Implement `packages/renderer/src/save-time-render.ts` (new).
- Wire into `pages.service.ts.updateSource`.
- Add mermaid + linkedom + Shiki bundled-langs.
- Render-pipeline tests.

### Day 10 — Publish fan-out + public read path

- `publishFanOut` helper in `publications.service.ts`.
- Update `/p/[slug].astro` and `/f/[slug].astro` to read R2 artifact + Cache API.
- Comments gating on `publication.permission`.
- Cache invalidation on publish.

### Day 11 — Images + UI chrome

- `compressBeforeUpload` script.
- Editor drop/paste integration.
- `/img/[...key].ts` route.
- Sweep `apps/web/src/assets/` to use `<Image />`.
- Remove `IMAGES` binding everywhere.

### Day 12 — Operations + tests + audit

- AWS SES verification (operator-side).
- Search reconciler cron handler.
- `/api/ready` deeper readiness probe.
- Sentry destination wired (operator-side via CF dashboard).
- Re-run the 5-parallel-agent audit. Resolve any new findings.
- Browser smoke checklist.
- Format / typecheck / test final pass.

### Day 13 (buffer)

- Address findings.
- Update CLAUDE.md with the new canonical patterns.
- Final wrangler.jsonc check-in.

---

## 14. Definition of done

The branch is shippable when ALL of:

### Code

- [ ] `pnpm format --check` exits 0
- [ ] `pnpm typecheck` exits 0, zero hints
- [ ] `pnpm test` exits 0 with ≥ 400 tests
- [ ] `pnpm --filter @vegastack/pages-web build` clean (no Node-API warnings, no chunk-size warnings)
- [ ] `dist/server/entry.mjs` total chunks < 2.5 MB compressed
- [ ] `runtime.ts` < 200 LOC
- [ ] Zero references to: `acquireRuntimeMutationLock`, `persistRuntimeState`, `hydrateRuntimeState`, `runtime_state`, `runtime_locks`, `ServiceError`, `attachEnvelope`, `SessionHandle`, `kv_namespaces`, `IMAGES` binding, `process.env.VPG_ADAPTER`
- [ ] Every service file is plain async functions over ServiceContext; no class singletons remaining in `packages/core/src/*`

### Schema

- [ ] `packages/db/migrations/` contains exactly two files: `0001_init.sql`, `0002_oauth_seed.sql`
- [ ] No legacy column or table remains in the live D1 (`runtime_state`, `runtime_locks`, `render_cache_key`, `reanchor_status`, `redirect_uris_json` all gone)
- [ ] All JSON columns have `CHECK (json_valid(x))`

### Infrastructure

- [ ] Live KV namespaces deleted (whatever was left over)
- [ ] Live D1 migration applied with the new shape
- [ ] Live R2 bucket retained; stale `pub/*` keys purged
- [ ] AWS SES sending domain verified
- [ ] Cloudflare Email Sending sending domain verified
- [ ] All required secrets set via `wrangler secret put`
- [ ] Sentry destination wired (operator action)
- [ ] Zone rate limit rules configured (operator action)
- [ ] DNS verified (already pointing at the Worker)

### Public read path

- [ ] `/p/[slug]` cache hit returns in < 20ms p95
- [ ] `/p/[slug]` cache miss does 1 D1 read + 1 R2 read + 0 render
- [ ] `view`-permission publications emit no comments markup
- [ ] `comment`/`edit` publications emit the lazy comments island
- [ ] Cache invalidation on publish-time update happens within 5 seconds

### Authoring path

- [ ] Page save (markdown) renders to R2 in < 300ms p95
- [ ] Page save with mermaid renders in < 800ms p95
- [ ] Concurrent saves of different pages don't block each other
- [ ] Concurrent saves of the same page → exactly one succeeds, others get 409
- [ ] Image upload compresses client-side (network payload ≤ 200KB for typical photos)
- [ ] `/img/[key]` returns in < 30ms p95 from edge cache

### Tests + audit

- [ ] All service-level tests added (per §12)
- [ ] All integration tests pass
- [ ] Render-pipeline tests pass
- [ ] Final 5-agent audit reports zero BLOCKER, zero HIGH unresolved
- [ ] Manual browser smoke (10-item checklist) all pass

### Deploy

- [ ] `wrangler deploy --dry-run` against the canonical `wrangler.jsonc` succeeds
- [ ] Operator runs the real `wrangler deploy`
- [ ] Health probe (`/api/health`) returns 200
- [ ] Readiness probe (`/api/ready`) returns 200
- [ ] First magic-link login on the live deploy works end-to-end (operator action: verify they get the email)

---

## 15. Risks + mitigations

| Risk                                                                                              | Severity | Mitigation                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mermaid bundle bloat pushes Worker over 10MB limit                                                | High     | Measure on day 9; if too big, lazy-load mermaid via dynamic import only when `has_mermaid` flag is set on any page in the cold-start workspace, OR move mermaid rendering to a separate `wrangler` "Worker for asset rendering" service |
| MDX evaluator in Workers has Node-only deps                                                       | Medium   | Validate on day 9 with a simple `<Callout>` MDX page; fall back to "render MDX server-side at deploy in a build step + ship the resulting HTML" if the runtime evaluator chokes                                                         |
| `db.batch` size limits for large folder moves                                                     | Low      | Each batch capped at 100 statements (configurable via `VPG_D1_MAX_BATCH_STATEMENTS`); folder moves with > 100 descendants paginate the rebuild                                                                                          |
| R2 lifecycle policy purges artifacts still pointed at by `publications.latest_artifact_key`       | Medium   | Lifecycle rule excludes keys where the `latest_content_hash` custom metadata matches a current publication. Tested via R2 lifecycle dry-run before enabling.                                                                            |
| Search reconciler runs simultaneously with a page save → conflicting writes to `search_documents` | Low      | Reconciler does `INSERT OR REPLACE` keyed by composite PK; saves do the same; D1 row-level atomicity handles the race                                                                                                                   |
| AWS SES rate limits during sign-up bursts                                                         | Low      | SES default is 14 emails/sec on production access; well under our expected load. Migrate to dedicated IP only if we hit 1M emails/month                                                                                                 |

---

## 16. Operator runbook (post-merge)

Once this plan is fully implemented and merged to `develop`:

1. Open Version PR via changesets workflow.
2. Smoke-test the prerelease (`vegastack-pages@1.0.0-next.0` on npm `next`).
3. Tag `v1.0.0` on `main`.
4. `release.yml` workflow runs:
   - `pnpm build`
   - `wrangler deploy` to `pages.vegastack.com`
   - `wrangler d1 migrations apply vegastack-pages-db --remote` (no-op if already applied)
5. Verify `/api/health` and `/api/ready` return 200.
6. Manual: hit `https://pages.vegastack.com/api/setup/complete` with the setup token to create the first admin (or skip if setup already complete).
7. Monitor Sentry destination for first-hour error rate.
8. Watch CF dashboard for cron firings (one fires at 03:00 UTC for GitHub backup, one at 03:30 UTC for search reconciler).

---

## 17. Deviation log

### 2026-05-17 — session 1 execution

**Days completed:** 2 (schema), 3c (structural cleanups), 4-8 (all 17 service rewrites), portions of 12 (ops endpoints + cron handler).

**Not yet started:** 1 (live-infra inventory, queued for maintainer), 3a (runtime.ts shrink — blocked on consumer migration of the legacy class-based services), 3b (middleware shrink — blocked on 3a), 9 (save-time renderer — requires maintainer go-ahead per "stop and ask" rule for new dependencies), 10 (publish fan-out + public read path rewrite), 11 (image pipeline).

**Key choices:**

1. **ServiceContext extended, not replaced.** Added `db?: D1Database` and `objectStore?: ObjectStore` as OPTIONAL fields alongside the existing `repo: RepoRegistry`. Marked optional so the four pre-rebuild services (favorites/comments/workspaces/pages) and their tests stayed green while the new direct-D1 services were stood up. `requireDb(ctx)` and `requireObjectStore(ctx)` helpers throw if the new services receive a ctx without them. Removal of the legacy `repo` field happens once the runtime.ts singletons are deleted (Phase D3a).

2. **`packages/db/src/types.ts` for D1 type aliases.** Defined a minimal `D1Database` / `D1PreparedStatement` shape there (mirroring the @cloudflare/workers-types surface we actually use) so `@vegastack/pages-services` doesn't depend on `@cloudflare/workers-types`. The same shape is satisfied by the production D1 binding and by `packages/services/src/__tests__/test-db.ts` (a node:sqlite-backed adapter that loads 0001_init.sql into `:memory:`).

3. **`sessionKVBindingName: false` directive in plan §11 is wrong.** The Astro 6 + @astrojs/cloudflare v13 `sessionKVBindingName` option takes a string (the binding name), not a boolean. There's no `false` value to disable auto-provisioning. Verified the codebase grep is clean of `Astro.session.*` usage, so the adapter won't auto-provision a SESSION KV binding regardless. Left astro.config.mjs untouched and skipped the `sessionKVBindingName` change.

4. **Legacy cols + tables still present in 0001_init.sql.** `pages.render_cache_key`, `comment_anchors.reanchor_status`, `runtime_state`, `runtime_locks`, and the `jobs` table are all still in the canonical schema because runtime.ts hasn't been shrunk yet (D3a). They'll be removed in the same commit that deletes runtime.ts's snapshot/persist/mutation-lock machinery.

5. **Route-test seeding now goes through the new direct-D1 services.** 7 failing route tests in `apps/web/src/pages/api/*/_tests/` were migrated from `pageService.createPage(...)` (legacy in-memory class) to `pages.create(ctx, ...)` (new direct-D1). Each test's `beforeAll` sets `VPG_RUNTIME=node` + a per-test `VPG_STATE_DIR` so the runtime hydrates to a clean SQLite file per test file. After D1 seeding, the test calls `refreshRuntimeState({ force: true })` so the legacy in-memory caches still consulted by some route paths (workspaceService.getMember, authService.getSession, pageService.getPage, commentService.getThread) reflect the freshly-inserted D1 rows. This bridge-pattern goes away once D3a deletes those caches.

6. **`folders.service.ts` path format change.** New service emits leading-slash paths (`/release-notes`) instead of the legacy bare slug. Updated one workspace-routes test assertion to match. Locked in by `packages/services/src/__tests__/folders.service.test.ts`.

7. **`USER_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `mcpSession: "mcs"`, `workspaceMember: "wmb"`, `permission: "per"` (and others) added to** `packages/core/src/errors.ts` and `packages/core/src/ids.ts` for the new services to throw / mint correctly.

8. **`vitest.config.ts` not modified.** Tried setting `VPG_RUNTIME=node` + `VPG_SQLITE_PATH=:memory:` globally to make every route test exercise the D1 path. Reverted — it broke other tests that depend on the legacy in-memory state path. Per-test env via `beforeAll` is the correct scope.

**Test state at end of session:** 412/412 passing (up from 321 baseline). `pnpm typecheck` clean (0 errors, 2 pre-existing cosmetic hints on `loginRedirectTarget`). `pnpm build` clean.

**Lines of code added:** ~5,000 (17 new/rewritten service files + 17 test files + foundation + ops endpoints). The pre-existing 90 uncommitted files (audit fixes) are still uncommitted at the maintainer's instruction.

---

End of plan.
