# Plan 010 — Clean-slate rebuild for production launch

**Status:** Draft, awaiting maintainer approval.
**Supersedes:** Plans 007, 008, 009 and audit reports 001–003. Once approved, those documents become historical record only.
**Owner:** @mk
**Drafted:** 2026-05-16
**Constraint:** Zero production users. No backward compatibility required. Anything that exists only for compat with old data, old URLs, or old client versions gets deleted.

---

## 0. Why this plan exists

Branch `feat/instant-workspace-v1` introduced four large structural changes (services package, repos abstraction, document partials + shell, mutation envelopes) but left them half-wired alongside the legacy in-memory snapshot model in `runtime.ts`. The previous plans (007/008/009) all proposed multi-phase migrations that assumed real users.

With no users today, the right move is not "migrate carefully" but "delete the legacy patterns and ship the canonical Astro 6 + Cloudflare Workers architecture in one branch."

This plan locks in every decision, lists every file to delete/rewrite/create, and orders the work into executable phases.

---

## 1. Final architecture — locked decisions

### 1.1 Compute topology

- **One Cloudflare Worker.** No two-Worker split. Smart Placement moves the single Worker close to D1 automatically.
- **`placement: { mode: "smart" }`** in `wrangler.jsonc`.
- **`compatibility_date: "2026-05-16"`**, **`compatibility_flags: ["nodejs_compat"]`** — nothing else.
- **Custom worker entry** at `apps/web/src/worker.ts` because we need a `scheduled()` handler for the GitHub backup cron. Use `ExportedHandler<Env>` with the auto-generated `Env` type from `wrangler types`.

### 1.2 Storage bindings

- **D1** (`DB`) — primary database. Single binding, no read replicas, no Sessions API in v1.
- **R2** (`CONTENT`) — page sources, attachments, page versions.
- **Images** (`IMAGES`) — runtime image transforms for embedded images.
- **Rate Limiting** (`ACTIONS_RL`) — per-user action quotas.

Removed:

- **KV (`SESSION`)** — never used. Astro's session API is not adopted (we have custom D1-backed auth). Delete the binding.
- **`send_email` binding** — not production-ready for cold-send transactional. Use Resend.

### 1.3 Data layer

- **No in-memory snapshot.** Delete `hydrateRuntimeState`, `persistRuntimeState`, `acquireRuntimeMutationLock`, `runtime_state` table, `runtime_locks` table, and ~1,650 LOC of supporting code.
- **Direct D1 reads/writes.** Each service function takes a `D1Database` reference and uses `prepare/bind/all/first/run/batch`. Multi-step writes use `db.batch([...])` for atomicity.
- **No module-level mutable state.** No shared `activeD1Batch`, no module `Map`s as data stores. Per-request scope only.
- **Squash all 21 migrations into one `0001_init.sql`** + a tiny `0002_oauth_seed.sql` for the two well-known OAuth clients.

### 1.4 Routing

- **All app pages live at `/app/*`.** The renderer files physically live in `pages/app/`. No top-level rewrites.
- **Root reserved for marketing + protocol + public surface:** `/`, `/docs/*`, `/p/[slug]`, `/f/[slug]`, `/auth/magic-link`, `/oauth/*`, `/authorize`, `/token`, `/register`, `/revoke`, `/device`, `/mcp`, `/.well-known/*`.
- **No backward-compat redirects.** `pages/login.astro`, `signup.astro`, `setup.astro`, `profile.astro`, `admin.astro`, `app/profile.astro`, `app/settings/sessions.astro` — all deleted.

### 1.5 Errors

- **Single error class: `AppError`** from `packages/core/src/errors.ts`.
- Delete `ServiceError`, `httpStatusFor`, `isServiceError` from `packages/services/src/errors.ts`.
- Services throw `AppError` with the existing `AppErrorCode` vocabulary. The `serviceErrorToResponse` helper collapses into one canonical `appErrorToResponse` in `apps/web/src/lib/error-response.ts`.

### 1.6 Mutations

- **Browser → Astro Actions.** Files under `apps/web/src/actions/{page,folder,comments,workspace,template}.ts`. Type-safe end-to-end, progressive enhancement, automatic devalue serialization. Browser components call `actions.page.save({...})`, not `fetch("/api/...")`.
- **MCP + CLI → REST `/api/*`.** The existing REST routes stay as the public, versioned contract. Their handlers become 3-liners that call the same services.
- Both surfaces emit **`MutationEnvelope`** on writes (envelope itself stays — it's small, additive, and the canonical signal to the browser/MCP/CLI for cache invalidation).
- Drop `attachEnvelope` (slower, re-parses JSON). Standardize on `jsonWithEnvelope`.

### 1.7 Navigation

- **Astro `<ClientRouter />`** in `AppLayout.astro` is the canonical SPA-feel mechanism.
- Add **`transition:persist`** on Sidebar, CommandPalette, CommentsRail, PageHeader, SonnerHost, MobileTabBar so they stay mounted across navigation.
- **Delete the custom shell** (`apps/web/src/scripts/shell/`, `apps/web/src/lib/document-payload.ts`, `apps/web/src/pages/api/workspaces/[workspaceId]/documents/`).
- **Prefetch on hover** stays on (already configured).

### 1.8 Caching

- **Workers Cache API** (`caches.default`) keyed by `request.url#contentHash` for `/p/[slug]` and `/f/[slug]`.
- `Cache-Control: public, max-age=0, s-maxage=86400, stale-while-revalidate=60` for indexable, `private, no-store` for authenticated, `private, max-age=60, Vary: Cookie` for password-gated.
- Invalidate on save by `cache.delete(...)` inside `ctx.waitUntil(...)`.
- **In-memory render cache** (`apps/web/src/lib/render-cache.ts`) stays as a per-isolate LRU (100 entries, keyed by content hash).
- **No R2 pre-rendered HTML artifact in v1.** Only add if Workers Cache misses observably exceed 150ms p50.

### 1.9 Images

- **Embedded user images:** stored raw in R2 under `attachments/{workspaceId}/{sha256}.{ext}`. A new route `apps/web/src/pages/img/[...key].ts` reads from R2, transforms via `env.IMAGES`, and caches the transform with `caches.default`. Markdown renderer emits `<img src="/img/{key}?w={width}" loading="lazy" decoding="async" />`.
- **Build-time UI images:** in `apps/web/src/assets/`, served via Astro's `<Image />` with `imageService: { build: "compile", runtime: "cloudflare-binding" }`.

### 1.10 Server Islands

Adopt `server:defer` for components whose data should not block first paint:

- `CommentsStatsBadge` — unresolved-threads count per page.
- `PermissionsHint` — member list peek.
- `WorkspaceMemberCount` — sidebar footer.
- `LastEditedBy` — page header attribution.

Skip server-defer for `FavoriteIndicator` (it's a single boolean — keep as `client:idle` with optimistic update).

Set `ASTRO_KEY` via `wrangler secret put` for rolling deploys.

### 1.11 Background work

- **`ctx.waitUntil`** for fire-and-forget post-response work (search reindex, audit log writes, cache fill). Accessed via `Astro.locals.cfContext.waitUntil(...)` per Astro 6 adapter v13.
- **Cron Trigger** for nightly GitHub backup sync — `triggers.crons: ["0 3 * * *"]` in `wrangler.jsonc`, handled in `worker.ts:scheduled`.
- **No Queues, no Workflows** in v1.

### 1.12 Email

- **Resend HTTPS API** for magic-link emails. Set `RESEND_API_KEY` via `wrangler secret put`.
- Delete the `send_email` binding from config and any `EMAIL` binding references in code.
- Helper at `apps/web/src/lib/email.ts` does a single `fetch` to `api.resend.com`.

### 1.13 Observability

- `observability.enabled: true` + `logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true }` + `tracing.enabled: true`.
- Connect tracing to **Sentry via OTLP export** (configured in the Cloudflare dashboard → Workers & Pages → Observability → Destinations).
- Structured JSON logs: `console.log(JSON.stringify({ msg, pageId, userId, ms }))`.

### 1.14 Security

- **Security headers in middleware** on HTML responses: CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP.
- **Stricter CSP on `/p/*` and `/f/*`** (public, no hydration inline-script need).
- **Cloudflare Rate Limiting Rules** in the dashboard for blunt DDoS on `/api/auth/*`, `/p/*`, `/_actions/*` (60/min/IP).
- **`ratelimits` binding** for per-user action quotas inside Worker code.
- **Magic-link auth stays as the only login method in v1.** WebAuthn passkeys as a follow-up before GA.

### 1.15 Env access

- **`import { env } from "cloudflare:workers"`** is the single canonical way to read bindings + secrets + vars in route/middleware code.
- **`import { X } from "astro:env/server"`** for typed plain string/number vars (declared in `astro.config.mjs`).
- **Delete every `process.env.VPG_*` read.**
- **One env-discriminator variable:** `VPG_RUNTIME` only. Drop `VPG_ADAPTER`.
- **Generated `Env` type** via `wrangler types` (run in `predev` and `prebuild`).

### 1.16 Node self-host

- Keep the Node adapter (lets self-hosters run on a single VM with SQLite + local filesystem).
- **Move all Node-only code into `apps/web/src/adapters/node/`** so the Cloudflare bundle never imports `node:fs`/`node:path`/`node:sqlite`.
- Adapter exports: `getNodeBindings()` returning `{ DB: NodeSqliteD1Database, CONTENT: FileObjectStore }`. The rest of the code reads bindings through a single `getBindings()` function that branches once on `VPG_RUNTIME`.

### 1.17 Fonts

- Keep `<Font />` from `astro:assets` with Fontsource Geist + Geist Mono.
- Narrow to weights 400/500/600/700 (not the full `100 900` axis).
- `display: "swap"` (currently `"block"` — bad for LCP).
- `preload` only on Geist body weight.

### 1.18 Heavy libs

- **Server-side per-page render flags**: at ingest, walk the AST and set `has_code`, `has_mermaid`, `has_math`, `has_wardley`, `has_cytoscape` columns on `pages`. The renderer dynamic-imports only what each page needs.
- **Client-side**: Mermaid, KaTeX, Cytoscape, Wardley hydrate **on intersection** (IntersectionObserver), not at load.
- **Shiki**: use `shiki/core` with explicit `bundledLanguages` to keep cold-start small.

---

## 2. Canonical configs

### 2.1 `apps/web/wrangler.jsonc` (replaces the release.yml generator block)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "vegastack-pages",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-05-16",
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
    "tracing": { "enabled": true },
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "vegastack-pages",
      "database_id": "${VPG_D1_DATABASE_ID}",
      "migrations_dir": "../../packages/db/migrations",
    },
  ],
  "r2_buckets": [
    {
      "binding": "CONTENT",
      "bucket_name": "vegastack-pages-content",
    },
  ],
  "images": { "binding": "IMAGES" },
  "ratelimits": [
    {
      "name": "ACTIONS_RL",
      "namespace_id": "1001",
      "simple": { "limit": 60, "period": 60 },
    },
  ],
  "triggers": { "crons": ["0 3 * * *"] },
  "vars": {
    "VPG_RUNTIME": "cloudflare",
    "VPG_DEPLOYMENT_MODE": "managed",
    "VPG_PUBLIC_SIGNUP": "true",
    "VPG_HOME_MODE": "landing",
  },
}
```

Secrets via `wrangler secret put`:

- `RESEND_API_KEY`
- `VPG_GITHUB_APP_PRIVATE_KEY`
- `VPG_GITHUB_APP_CLIENT_ID`
- `VPG_GITHUB_APP_CLIENT_SECRET`
- `ASTRO_KEY` (for server-island prop encryption across deploys)

The CI workflow stops generating the wrangler config at deploy time; this file is the canonical source and is checked into the repo.

### 2.2 `apps/web/astro.config.mjs` (canonical highlights)

```js
import { defineConfig, envField } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    imageService: { build: "compile", runtime: "cloudflare-binding" },
    imagesBindingName: "IMAGES",
    prerenderEnvironment: "node",
  }),
  prefetch: { defaultStrategy: "hover" },
  env: {
    schema: {
      VPG_RUNTIME: envField.enum({
        context: "server",
        access: "secret",
        values: ["cloudflare", "node"],
        default: "cloudflare",
      }),
      VPG_DEPLOYMENT_MODE: envField.enum({
        context: "server",
        access: "secret",
        values: ["managed", "self-hosted"],
        default: "managed",
      }),
      VPG_PUBLIC_SIGNUP: envField.boolean({
        context: "server",
        access: "secret",
        default: true,
      }),
      VPG_HOME_MODE: envField.enum({
        context: "server",
        access: "secret",
        values: ["landing", "redirect_to_app", "redirect_to_first_page"],
        default: "landing",
      }),
      RESEND_API_KEY: envField.string({ context: "server", access: "secret" }),
      VPG_GITHUB_APP_ID: envField.string({
        context: "server",
        access: "secret",
        optional: true,
      }),
    },
  },
  experimental: {
    // No experimental flags — all features used are stable in Astro 6.
  },
  // ...keep existing markdown/mermaid/shiki config
});
```

### 2.3 `apps/web/src/worker.ts`

```ts
import { handle } from "@astrojs/cloudflare/handler";
import { runDueGitHubBackupSyncs } from "./lib/github-backup";

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runDueGitHubBackupSyncs(env));
  },
} satisfies ExportedHandler<Env>;
```

`Env` is auto-generated by `wrangler types` into `worker-configuration.d.ts`.

### 2.4 `install/cloudflare/wrangler.example.jsonc` (single self-host example)

Mirror the production config above, with `database_id` and `bucket_name` placeholders. Delete `wrangler.backend.example.jsonc` and `wrangler.frontend.example.jsonc` — these described the dropped two-Worker split.

Add an ASCII architecture diagram at the top of the example file (copy from §11 below).

---

## 3. Schema squash — `packages/db/migrations/0001_init.sql`

### 3.1 Tables in the final schema

| Table                                                | Notes                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                                              | UNIQUE(email)                                                                                                                                                                                                                                                                                                                                                |
| `auth_identities`                                    | UNIQUE(provider, provider_subject); idx(user_id)                                                                                                                                                                                                                                                                                                             |
| `auth_sessions`                                      | idx(user_id); **add idx(expires_at)** for sweep                                                                                                                                                                                                                                                                                                              |
| `magic_links`                                        | UNIQUE(token_hash); idx(email); **add idx(expires_at)**                                                                                                                                                                                                                                                                                                      |
| `workspaces`                                         | UNIQUE(slug); includes `version_retention_days`                                                                                                                                                                                                                                                                                                              |
| `workspace_members`                                  | UNIQUE(workspace, user); idx(user)                                                                                                                                                                                                                                                                                                                           |
| `permissions`                                        | UNIQUE(workspace, subject_type, subject_id, scope, target_id); idx(workspace, subject_id)                                                                                                                                                                                                                                                                    |
| `folders`                                            | **Declare FK `parent_folder_id REFERENCES folders(id) ON DELETE CASCADE`**; UNIQUE(slug_id); idx(workspace_id, parent_folder_id, position)                                                                                                                                                                                                                   |
| `pages`                                              | UNIQUE(slug_id); idx(workspace_id, folder_id, position) WHERE deleted_at IS NULL; idx(workspace_id, updated_at DESC) WHERE deleted_at IS NULL; idx(workspace_id, deleted_at) WHERE deleted_at IS NOT NULL. **Add `has_code`, `has_mermaid`, `has_math`, `has_wardley`, `has_cytoscape` INTEGER cols** for renderer flag gating. **Drop `render_cache_key`**. |
| `page_versions`                                      | idx(page_id, created_at DESC)                                                                                                                                                                                                                                                                                                                                |
| `page_favorites`                                     | composite PK; idx(user_id, workspace_id, created_at DESC); idx(page_id)                                                                                                                                                                                                                                                                                      |
| `workspace_templates`, `workspace_template_versions` | idx(workspace_id, category, name)                                                                                                                                                                                                                                                                                                                            |
| `comment_threads`                                    | idx(page_id, status, created_at DESC); idx(publication_id) WHERE publication_id IS NOT NULL                                                                                                                                                                                                                                                                  |
| `comment_anchors`                                    | All metadata cols folded in. Drop `reanchor_status` (superseded by `confidence`).                                                                                                                                                                                                                                                                            |
| `comment_replies`                                    | idx(thread_id, created_at)                                                                                                                                                                                                                                                                                                                                   |
| `publications`                                       | UNIQUE(workspace, resource_type, resource_id); idx(resource_type, resource_id)                                                                                                                                                                                                                                                                               |
| `attachments`                                        | idx(page_id); idx(workspace_id)                                                                                                                                                                                                                                                                                                                              |
| `audit_logs`                                         | idx(workspace_id, created_at DESC)                                                                                                                                                                                                                                                                                                                           |
| `review_events`                                      | idx(workspace_id, created_at DESC); idx(page_id)                                                                                                                                                                                                                                                                                                             |
| `search_documents`                                   | composite PK (resource_type, resource_id); idx(workspace, resource_type, updated_at)                                                                                                                                                                                                                                                                         |
| `search_documents_fts`                               | FTS5 virtual table mirroring `search_documents` via **AFTER INSERT/UPDATE/DELETE triggers** — not manual app-code mirroring                                                                                                                                                                                                                                  |
| `search_recent_resources`                            | composite PK; idx(user, workspace, last_opened_at)                                                                                                                                                                                                                                                                                                           |
| `setup_state`                                        | single-row config                                                                                                                                                                                                                                                                                                                                            |
| `rate_limits`                                        | idx(reset_at)                                                                                                                                                                                                                                                                                                                                                |
| `agent_sessions`                                     | merged 0018+0019 shape; **omit `redirect_uris_json`**                                                                                                                                                                                                                                                                                                        |
| `mcp_sessions`                                       | UNIQUE(refresh_token_hash) WHERE NOT NULL                                                                                                                                                                                                                                                                                                                    |
| `oauth_clients`                                      | from 0018                                                                                                                                                                                                                                                                                                                                                    |
| `oauth_grants`                                       | merged from 0018+0019, with CHECK constraints                                                                                                                                                                                                                                                                                                                |
| `github_sync_connections`                            | UNIQUE(workspace); idx(installation_id)                                                                                                                                                                                                                                                                                                                      |
| `github_sync_runs`                                   | idx(connection, started_at); idx(workspace)                                                                                                                                                                                                                                                                                                                  |
| `schema_migrations`                                  | declared here, not lazily by app code                                                                                                                                                                                                                                                                                                                        |

### 3.2 Tables explicitly removed

- **`runtime_state`** — snapshot blob. Pattern is gone.
- **`runtime_locks`** — global mutation lock. Pattern is gone.
- **`oauth_auth_codes`, `oauth_device_codes`** — merged into `oauth_grants` (already done in 0019).
- **`guest_comment_sessions`** — stub migration 0011 was a no-op; no table existed.

### 3.3 Constraints + JSON validation

- Add `CHECK (json_valid(x))` on every JSON-blob column: `frontmatter_json`, `payload_json`, `properties_json`, `metadata_json`, `redirect_uris_json` (the kept ones), `selector_json`.
- Make every `*_at` column `NOT NULL` where the app always sets it (audit-logs reveals most are always populated).
- Add `DEFAULT '{}'` to `pages.frontmatter_json` and similar.

### 3.4 Seeds (`0002_oauth_seed.sql`)

`INSERT OR IGNORE` the two well-known OAuth clients (`oac_vpg_cli`, `oac_anthropic_connector`). Everything else seeds at first-boot via `ensureSeedData()` going through the canonical services.

### 3.5 Drizzle decision

- **Delete `packages/db/src/schema.ts`** (Drizzle definitions). The app doesn't import it; keeping it is drift surface.
- Row types live in `packages/db/src/types.ts` as hand-written `interface` definitions matching the SQL. Smaller surface, no codegen needed.

---

## 4. Delete list (complete)

### 4.1 Whole files / directories

```
apps/web/src/backend/                                          ← stub 503 dispatcher
apps/web/src/lib/api-client.ts                                 ← unused dispatcher
apps/web/src/lib/runtime/target.ts                             ← unused target detector
apps/web/src/lib/runtime/repos/                                ← in-memory adapters (replaced by direct D1 services)
apps/web/src/scripts/shell/                                    ← custom shell controller + tests
apps/web/src/lib/document-payload.ts                           ← partial-fetch payload builder
apps/web/src/pages/api/workspaces/[workspaceId]/documents/     ← new route surface for the shell
install/cloudflare/wrangler.backend.example.jsonc              ← dropped two-Worker split
install/cloudflare/wrangler.frontend.example.jsonc             ← dropped two-Worker split
apps/web/src/pages/login.astro                                 ← URL moves to /app/login (file body relocates)
apps/web/src/pages/signup.astro                                ← URL moves to /app/signup
apps/web/src/pages/setup.astro                                 ← URL moves to /app/setup
apps/web/src/pages/profile.astro                               ← legacy redirect, no users
apps/web/src/pages/admin.astro                                 ← legacy redirect, no users
apps/web/src/pages/app/profile.astro                           ← legacy redirect, no users
apps/web/src/pages/app/settings/sessions.astro                 ← legacy redirect to /connections
packages/services/src/publications.service.ts                  ← unused (publication-api.ts is canonical for v1)
packages/services/src/repo/publication.repo.ts                 ← companion to above
packages/db/src/schema.ts                                      ← Drizzle drift surface
packages/db/migrations/0002_runtime_state.sql                  ← snapshot pattern dropped
packages/db/migrations/0003_search_documents.sql               ← redundant with 0001
packages/db/migrations/0004_runtime_records.sql                ← redundant with 0001
packages/db/migrations/0005_page_version_id.sql                ← folded into 0001 init
packages/db/migrations/0006_rate_limits.sql                    ← folded into 0001 init
packages/db/migrations/0007_runtime_locks.sql                  ← mutation lock dropped
packages/db/migrations/0008_workspace_retention.sql            ← folded
packages/db/migrations/0009_workspace_templates.sql            ← folded
packages/db/migrations/0010_expand_page_slug_ids.sql           ← one-off data backfill, no users
packages/db/migrations/0011_guest_comment_sessions.sql         ← no-op stub
packages/db/migrations/0012_page_favorites.sql                 ← folded
packages/db/migrations/0013_workspace_search_resources.sql     ← folded
packages/db/migrations/0014_dense_folder_positions.sql         ← one-off backfill
packages/db/migrations/0015_github_sync.sql                    ← folded
packages/db/migrations/0016_comment_anchor_metadata.sql        ← folded
packages/db/migrations/0017_remove_area_comment_anchors.sql    ← one-off rect→point migration
packages/db/migrations/0018_oauth_clients_and_sessions.sql     ← folded
packages/db/migrations/0019_oauth_schema_cleanup.sql           ← folded
packages/db/migrations/0020_oauth_well_known_vpg_cli.sql       ← becomes 0002_oauth_seed.sql
packages/db/migrations/0021_oauth_well_known_anthropic_connector.sql ← becomes 0002_oauth_seed.sql
docs/audit-cycle-3-findings.md                                 ← historical noise
docs/audit-cycle-3-summary.md                                  ← historical noise
docs/audit-cycle-3-verification.md                             ← historical noise
docs/audit-report-001.md                                       ← historical noise
docs/audit-report-002.md                                       ← historical noise
docs/implementation-report-007.md                              ← historical noise
docs/plans/007-instant-workspace-architecture.md               ← superseded by this plan
docs/plans/008-architecture-speedup-audit.md                   ← superseded
docs/plans/009-grounded-architecture-rebuild.md                ← superseded
```

### 4.2 Symbols / sections inside files

**`apps/web/src/lib/runtime.ts`** (file shrinks from 3,437 → ~400 LOC):

- Delete `RuntimeSnapshot` type (lines 85-100)
- Delete `createRuntimeSnapshot`, `restoreRuntimeSnapshot` (757-944)
- Delete `mapEntries`, `arrayValue`, `restoreMap`, `restoreArray`, `serviceMapValues`, `serviceArrayValues` (534-565, 735-743)
- Delete `hydrateRuntimeState`, `hydrateNormalizedRuntimeState`, `ensureRuntimeReady`, `refreshRuntimeState`, `rebuildSearchIndexFromRuntime` (1081-1645, 1722-1758, 1760-1794)
- Delete `acquireRuntimeMutationLock`, `persistRuntimeState`, `persistNormalizedRuntimeState`, `persistNormalizedRuntimeStateBatch`, `deleteNormalizedRuntimeState` (1796-2886)
- Delete `hydrateNodeState`, `persistNodeState`, `nodeStateFilePath` (946-954, 1054-1079)
- Delete `runtimeIsD1`, `runtimeHydratedFromNormalizedTables`, `activeD1Batch`, `fallbackMcpSessions`, `fallbackRefreshIndex` module-level state (428-435, 567-569, 2162)
- Delete `normalizeCommentAnchorRecord` and friends (675-733)
- Delete `legacyMcpSessionListId`, `maskListedMcpSession`, `resolveStoredMcpSessionId` (465-474, 2326-2345)
- Delete the hand-rolled `CREATE TABLE IF NOT EXISTS` bootstrap block (1118-1320)
- Service singletons (`pageService`, `workspaceService`, etc., 335-347): **delete the singleton wiring** — but the underlying logic in `packages/core/src/*-service.ts` moves into `packages/services/src/*.service.ts` as direct-D1 functions.

**`apps/web/src/middleware.ts`**:

- Delete the mutation-lock block (158-178). Replace with `return next();` plus security-header injection.

**`apps/web/src/pages/mcp.ts`**:

- Delete the `acquireRuntimeMutationLock` / `refreshRuntimeState` / `persistRuntimeState` boilerplate (~248-270).
- Each tool handler calls the new service directly.

**`packages/services/src/errors.ts`**: delete `ServiceError`, `httpStatusFor`, `isServiceError`. The file becomes a re-export from `packages/core/src/errors.ts`.

**`packages/services/src/envelope.ts`**: delete `attachEnvelope` (keep `buildEnvelope` + `jsonWithEnvelope`).

**`packages/services/src/context.ts`**: delete `SessionHandle`, `SessionPreparedStatement` types and the `session` field on `ServiceContext`.

**`apps/web/src/lib/service-context.ts`**: delete the throwing `session` stub at lines 47-58. Delete `serviceErrorToResponse` (replaced by `appErrorToResponse` in `lib/error-response.ts`).

**`apps/web/src/lib/runtime/repos/index.ts`**: delete the `commentService` test backdoor export.

**`apps/web/src/pages/{index,app/index,login,signup,setup}.astro`**: drop the unused `loginRedirectTarget`, `legacySessionsRedirect` imports.

**`apps/web/src/pages/api/comment-threads/[threadId]/anchor.ts:45` and `.../index.ts:30`**: replace `const access = await resolvePageAccess(...)` with `await resolvePageAccess(...)` (call for side-effect only, no unused binding). Add a `// throws on no access` comment.

**Every `apps/web/src/pages/api/**/\_.ts`route**: replace`process.env.VPG\_\_`reads with`env.VPG\_\*`from`cloudflare:workers`(or`astro:env/server` for typed strings).

**`apps/web/src/lib/access.ts` + `resource-access-api.ts`**: merge `resource-access-api.ts` into `access.ts`. Delete `resource-access-api.ts`. Update imports across 11 files.

---

## 5. Rewrite list (files that exist but get a new shape)

### 5.1 `packages/services/src/*.service.ts` (10 files)

Each service:

- Exports plain async functions, not class methods on a singleton.
- Each function's first argument is `ctx: ServiceContext` containing `{ db, objectStore, actor, env, waitUntil }`.
- Reads use `ctx.db.prepare(...).bind(...).all()/.first()`.
- Multi-step writes use `ctx.db.batch([...])` for atomicity.
- Throws `AppError` (not `ServiceError`).
- Background side effects use `ctx.waitUntil(...)` (which forwards to the real `Astro.locals.cfContext.waitUntil`).

**Concrete signatures** (representative, not exhaustive):

```ts
// packages/services/src/pages.service.ts
export async function get(
  ctx: ServiceContext,
  args: { workspaceId: string; pageId: string },
): Promise<PageRecord>;
export async function listInFolder(
  ctx: ServiceContext,
  args: { workspaceId: string; folderId: string | null },
): Promise<PageRecord[]>;
export async function create(
  ctx: ServiceContext,
  args: {
    workspaceId: string;
    folderId: string | null;
    title: string;
    source: string;
    sourceType: SourceType;
  },
): Promise<{ page: PageRecord; envelope: MutationEnvelope }>;
export async function patch(
  ctx: ServiceContext,
  args: {
    pageId: string;
    baseVersionId: string;
    title?: string;
    source?: string;
  },
): Promise<{ page: PageRecord; envelope: MutationEnvelope }>;
export async function move(
  ctx: ServiceContext,
  args: { pageId: string; folderId: string | null; position?: number },
): Promise<{ page: PageRecord; envelope: MutationEnvelope }>;
export async function softDelete(
  ctx: ServiceContext,
  args: { pageId: string },
): Promise<{ envelope: MutationEnvelope }>;
export async function favorite(
  ctx: ServiceContext,
  args: { pageId: string; userId: string },
): Promise<{ envelope: MutationEnvelope }>;
export async function unfavorite(
  ctx: ServiceContext,
  args: { pageId: string; userId: string },
): Promise<{ envelope: MutationEnvelope }>;
export async function pruneExpiredVersions(
  ctx: ServiceContext,
  args: { workspaceId: string },
): Promise<{ deleted: number }>;
```

Multi-step example — `pages.service.ts:move`:

```ts
export async function move(ctx, { pageId, folderId, position }) {
  const page = await ctx.db
    .prepare(
      "SELECT id, workspace_id, title, slug, slug_id, folder_id, updated_at FROM pages WHERE id=?1 AND deleted_at IS NULL",
    )
    .bind(pageId)
    .first<PageRow>();
  if (!page) throw new AppError("PAGE_NOT_FOUND");
  if (folderId !== null) {
    const folder = await ctx.db
      .prepare("SELECT id FROM folders WHERE id=?1 AND workspace_id=?2")
      .bind(folderId, page.workspace_id)
      .first();
    if (!folder) throw new AppError("FOLDER_NOT_FOUND");
  }
  const now = new Date().toISOString();
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE pages SET folder_id=?1, position=?2, updated_at=?3 WHERE id=?4",
      )
      .bind(folderId, position ?? null, now, pageId),
    ctx.db
      .prepare(
        "INSERT INTO audit_logs (id, workspace_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?1, ?2, ?3, 'page.move', 'page', ?4, ?5, ?6)",
      )
      .bind(
        newId(),
        page.workspace_id,
        ctx.actor.userId,
        pageId,
        JSON.stringify({ from_folder: page.folder_id, to_folder: folderId }),
        now,
      ),
  ]);
  ctx.waitUntil(scheduleIndexPage(ctx, pageId));
  ctx.waitUntil(invalidatePublicationCache(ctx, page.workspace_id, pageId));
  const fresh = await get(ctx, { workspaceId: page.workspace_id, pageId });
  return {
    page: fresh,
    envelope: await buildEnvelope(ctx, page.workspace_id, [
      { type: "page", id: pageId },
    ]),
  };
}
```

### 5.2 `apps/web/src/middleware.ts`

```ts
export const onRequest = defineMiddleware(async (context, next) => {
  // 1. Resolve actor from cookie session (already exists)
  context.locals.actor = await resolveActor(context);

  // 2. CSRF on unsafe methods (already exists)
  if (!isSafeMethod(context.request) && !isOAuthOrMcp(context.url.pathname)) {
    assertCsrf(context);
  }

  // 3. Per-action rate limit
  if (
    context.url.pathname.startsWith("/_actions/") &&
    context.locals.actor.userId
  ) {
    const { success } = await env.ACTIONS_RL.limit({
      key: `actions:${context.locals.actor.userId}`,
    });
    if (!success) return jsonAppError(new AppError("RATE_LIMITED"));
  }

  // 4. Hand off
  const response = await next();

  // 5. Security headers on HTML
  if (response.headers.get("content-type")?.startsWith("text/html")) {
    applySecurityHeaders(response, context.url);
  }

  return response;
});
```

No `acquireRuntimeMutationLock`. No `ensureRuntimeReady`. No `persistRuntimeState`. ~150 LOC reduction.

### 5.3 `apps/web/src/pages/api/*` routes

Every route becomes the pattern below. Total ~30 routes, each ~15 LOC.

```ts
// apps/web/src/pages/api/pages/[pageId]/move.ts
import type { APIRoute } from "astro";
import { buildServiceContext } from "../../../../lib/service-context";
import { jsonWithEnvelope } from "@vegastack/pages-services/envelope";
import { appErrorToResponse } from "../../../../lib/error-response";
import * as pages from "@vegastack/pages-services/pages";

export const POST: APIRoute = async (astroCtx) => {
  try {
    const ctx = await buildServiceContext(astroCtx);
    const body = await astroCtx.request.json();
    const result = await pages.move(ctx, {
      pageId: astroCtx.params.pageId,
      folderId: body.folderId,
      position: body.position,
    });
    return jsonWithEnvelope(result.page, result.envelope);
  } catch (error) {
    return appErrorToResponse(error);
  }
};
```

### 5.4 `apps/web/src/actions/*.ts` (NEW)

```ts
// apps/web/src/actions/page.ts
import { defineAction, ActionError } from "astro:actions";
import { z } from "astro:schema";
import { buildServiceContext } from "../lib/service-context";
import * as pages from "@vegastack/pages-services/pages";

export const move = defineAction({
  input: z.object({
    pageId: z.string(),
    folderId: z.string().nullable(),
    position: z.number().int().optional(),
  }),
  handler: async (input, astroCtx) => {
    const ctx = await buildServiceContext(astroCtx);
    return await pages.move(ctx, input);
  },
});

// ...favorite, save, archive, etc.
```

Browser callers (`apps/web/src/components/Sidebar.tsx`, etc.) switch from `fetch("/api/pages/...")` to `await actions.page.move({ ... })`.

### 5.5 `apps/web/src/layouts/AppLayout.astro`

```astro
---
import { ClientRouter } from "astro:transitions";
import "../styles/global.css";
---

<html lang="en">
  <head>
    <ClientRouter />
    <!-- ...rest of head -->
  </head>
  <body>
    <aside transition:persist="vpg-sidebar"><Sidebar client:load /></aside>
    <header transition:persist="vpg-page-header"><PageHeader /></header>
    <CommandPalette client:idle transition:persist="vpg-command-palette" />
    <slot />
    <CommentsRail client:idle transition:persist="vpg-comments-rail" />
    <SonnerHost client:idle transition:persist="vpg-sonner" />
    <MobileTabBar transition:persist="vpg-mobile-tabbar" />
  </body>
</html>
```

Delete the giant deferred-shell-activation comment block at the top of the current file.

### 5.6 `apps/web/src/pages/p/[slugId].astro` and `f/[slugId].astro`

Wrap the response in Workers Cache:

```astro
---
const cacheKey = new Request(
  `${Astro.url.toString()}#${publication.contentHash}`,
  Astro.request,
);
const cached = await caches.default.match(cacheKey);
if (cached) return cached;

// ...render as today...
const response = new Response(htmlBody, { headers });
Astro.locals.cfContext.waitUntil(
  caches.default.put(cacheKey, response.clone()),
);
return response;
---
```

Invalidation happens inside `publications.service.ts.update()` via `ctx.waitUntil(caches.default.delete(...))`.

### 5.7 `apps/web/src/lib/runtime.ts` (post-shrink)

Final exports:

- `getDb()`, `getObjectStore()` — singleton accessors
- `assertRuntimeStorageBindings()`
- `d1All`, `d1Run`, `d1Batch` (refactored — no module-level batch buffer)
- `boolFromDb`, `jsonFromDb`, `jsonToDb`, `sleep`
- `sha256Hex`
- `requiresManagedDurableStorage`, `ephemeralContentAllowed` config gates
- `getRuntimeBindings()` for the Cloudflare branch + a sibling `getNodeBindings()` from the adapter.

That's the entire file. ~400 LOC.

---

## 6. New files

```
apps/web/src/actions/
├── index.ts                        # exports { page, folder, comments, workspace, template }
├── page.ts                         # save, move, favorite, archive, restore, publish, ...
├── folder.ts                       # create, rename, move, reorder, delete, ...
├── comments.ts                     # postThread, postReply, resolve, unresolve, anchor, complete
├── workspace.ts                    # invite, removeMember, updateSettings, leave, ...
└── template.ts                     # create, update, delete, listVersions

apps/web/src/adapters/node/
├── index.ts                        # getNodeBindings()
├── file-object-store.ts            # moved from runtime.ts:156-260
├── node-sqlite-d1.ts               # moved from runtime.ts:262-331
└── sqlite-bootstrap.ts             # moved from runtime.ts:956-1052

apps/web/src/lib/
├── env.ts                          # const env = await import("cloudflare:workers").then(m => m.env)
├── error-response.ts               # appErrorToResponse — canonical
├── security-headers.ts             # applySecurityHeaders(response, url)
├── email.ts                        # Resend HTTPS API
└── cache-key.ts                    # cacheKeyForPublication(url, contentHash)

apps/web/src/pages/
├── img/[...key].ts                 # R2 → IMAGES transform → caches.default
├── app/login.astro                 # moved from /login.astro
├── app/signup.astro                # moved from /signup.astro
└── app/setup.astro                 # moved from /setup.astro

apps/web/src/components/
├── CommentsStatsBadge.astro        # server:defer
├── PermissionsHint.astro           # server:defer
├── WorkspaceMemberCount.astro      # server:defer
└── LastEditedBy.astro              # server:defer

apps/web/src/scripts/
├── prose-enhancers.ts              # existing — but verify idempotent on astro:page-load
├── mermaid-lazy.ts                 # intersection-observer + dynamic import
├── katex-lazy.ts
├── cytoscape-lazy.ts
└── wardley-lazy.ts

packages/db/
├── migrations/
│   ├── 0001_init.sql               # squashed schema
│   └── 0002_oauth_seed.sql         # well-known OAuth clients
└── src/
    └── types.ts                    # hand-written row interfaces (replaces schema.ts)

apps/web/wrangler.jsonc              # canonical, checked-in (replaces release.yml generator)
```

---

## 7. Phased execution order

Each phase is a single commit or PR-sized chunk. Phases are sequential; each leaves the build green.

### Phase 0 — Branch hygiene (½ day)

1. Run `pnpm format` on all 48 files.
2. Add a changeset: `pnpm changeset` → minor bump on `@vegastack/pages` with a one-paragraph summary.
3. Run `pnpm typecheck` + `pnpm test` to confirm starting point is clean.
4. Tag the commit so we can revert if anything goes wrong.

### Phase 1 — Routing relocation + dead-route deletion (½ day)

1. Move `apps/web/src/pages/login.astro` content → `apps/web/src/pages/app/login.astro` (replace the existing rewrite stub). Fix relative imports.
2. Same for `signup.astro` → `app/signup.astro`, `setup.astro` → `app/setup.astro`.
3. Delete `pages/login.astro`, `pages/signup.astro`, `pages/setup.astro`, `pages/profile.astro`, `pages/admin.astro`, `pages/app/profile.astro`, `pages/app/settings/sessions.astro`.
4. Update `apps/web/src/lib/auth-redirects.ts`: collapse `loginRedirectTarget` to one rule — return `"/app"` if target is `/app/login` or `/login`, else the validated target.
5. Update internal links in `index.astro:175,178` and `lib/settings-data.ts:33,61` and any others pointing at deleted paths.
6. Drop the 5 unused imports flagged by typecheck (`loginRedirectTarget`, `legacySessionsRedirect`).
7. Run `pnpm typecheck` + `pnpm test`.

### Phase 2 — Wrangler v4 + Astro 6 idiom (1 day)

1. `pnpm up wrangler@latest -r`. Regenerate types with `pnpm wrangler types`.
2. Write the canonical `apps/web/wrangler.jsonc` (§2.1). Check it in.
3. Remove the wrangler-generator block from `.github/workflows/release.yml`. The deploy step now reads the checked-in config and only injects `${VPG_D1_DATABASE_ID}` from secrets.
4. Update `apps/web/src/worker.ts` to use `ExportedHandler<Env>` + typed bindings (§2.3).
5. Add `predev` and `prebuild` scripts in `apps/web/package.json`: `wrangler types && astro check`.
6. Replace every `process.env.VPG_*` read with `import { env } from "cloudflare:workers"` (one mechanical sweep across `runtime.ts`, `middleware.ts`, `email.ts`, `background.ts`, `github-backup.ts`, `mcp.ts`, all `pages/api/**`, all `.astro` frontmatters). Plain-string typed vars use `astro:env/server`.
7. Drop `VPG_ADAPTER` references — keep only `VPG_RUNTIME`. Update `apps/web/src/pages/api/local/status.ts:21`.
8. Run `pnpm typecheck` + `pnpm test`.

### Phase 3 — Dead-code purge (1 day)

1. Delete the files in §4.1 (backend stub, api-client, target.ts, shell scripts, document-payload, document API routes, two example wrangler files).
2. Delete `ServiceError` and `attachEnvelope`; consolidate to `AppError` + `jsonWithEnvelope` (§4.2). Update the routes that import them.
3. Delete `SessionHandle` from `ServiceContext`.
4. Delete the `commentService` test-backdoor export from `runtime/repos/index.ts`.
5. Delete `packages/services/src/publications.service.ts` and its repo (publication-api.ts stays canonical for v1).
6. Delete `packages/db/src/schema.ts` (the Drizzle definitions).
7. Merge `apps/web/src/lib/resource-access-api.ts` into `access.ts`; delete the source file and update imports.
8. Fix the two `const access = ...` reads in `comment-threads/{anchor,index}.ts:45/30`.
9. Run `pnpm typecheck` + `pnpm test`.

### Phase 4 — Schema squash + Node adapter split (1.5 days)

1. Write `packages/db/migrations/0001_init.sql` per §3.
2. Write `packages/db/migrations/0002_oauth_seed.sql` (well-known clients).
3. Delete all 21 old migration files.
4. Write `packages/db/src/types.ts` with row interfaces.
5. Create `apps/web/src/adapters/node/` and move `FileObjectStore`, `NodeSqliteD1Database`, `NodeSqlitePreparedStatement`, `findNodeMigrationsDir`, `createNodeSqliteD1`, `runNodeSqliteMigrations` out of `runtime.ts`.
6. Wipe `.vegastack-pages/local/` locally and re-run `pnpm local:setup` to confirm fresh init works.
7. Run `pnpm test` (most tests should pass; failures fixed in Phase 5).

### Phase 5 — Rewrite `runtime.ts` + services as direct-D1 (3 days)

1. **Rewrite each service** in `packages/services/src/*.service.ts` to take `ServiceContext` and use direct D1 reads/writes. Pull the pure logic out of the existing `packages/core/src/*-service.ts` files (slug generation, validation, content hashing, anchor coercion). Once a service is rewritten, delete its old singleton from `packages/core`.
2. **Drop the in-memory storage** from every service. Each method becomes a function exported from `packages/services/src/<name>.service.ts`.
3. **Shrink `apps/web/src/lib/runtime.ts`** to ~400 LOC: keep only `getDb`, `getObjectStore`, `assertRuntimeStorageBindings`, D1 helpers, scalar converters, `sha256Hex`, `getRuntimeBindings`.
4. **Refactor `d1Batch`** to not use a module-level buffer. Either take an array of statements directly, or accept a builder function that returns statements.
5. **Shrink `apps/web/src/middleware.ts`** to the §5.2 shape — no lock, no refresh, no persist; just auth + CSRF + rate-limit + security headers.
6. **Migrate every API route** to the §5.3 thin-handler shape.
7. **Migrate MCP** (`apps/web/src/pages/mcp.ts`) — delete the lock/persist boilerplate; each tool handler calls the new service directly.
8. **Write a Vitest suite** covering each service's core flows against an in-memory `better-sqlite3` D1 (via the Node adapter). Mirror the current 349-test surface.
9. Run `pnpm typecheck` + `pnpm test`. Fix until green.

### Phase 6 — ClientRouter + transition:persist (½ day)

1. Edit `apps/web/src/layouts/AppLayout.astro` per §5.5. Delete the deferred-shell comment block.
2. Verify each persisted island (Sidebar, CommandPalette, CommentsRail, PageHeader, SonnerHost, MobileTabBar) handles re-prop'd navigation correctly. Add explicit `transition:persist-props` only if a specific island needs frozen props.
3. Wire `astro:before-preparation` → top progress bar (`apps/web/src/components/NavProgress.astro`).
4. Wire `astro:after-swap` → scroll restoration + theme paint.
5. Test in browser: sidebar stays mounted, no flash, no scroll-jump.

### Phase 7 — Astro Actions (1.5 days)

1. Create `apps/web/src/actions/` with one file per resource (§5.4).
2. Add `Astro.locals.actions` typing via `astro:actions`.
3. Convert browser callers in `apps/web/src/components/**/*.tsx` from `fetch("/api/...")` to `await actions.<resource>.<verb>({ ... })`. Estimated ~25 call sites.
4. Keep the REST `/api/*` routes for MCP + CLI — they call the same services.
5. Run progressive-enhancement smoke test: disable JS, submit a form, verify the PRG flow still works (where applicable).
6. Run `pnpm typecheck` + `pnpm test`.

### Phase 8 — Workers Cache + Server Islands (1 day)

1. Edit `apps/web/src/pages/p/[slugId].astro` per §5.6: wrap response in `caches.default` keyed by `url#contentHash`.
2. Same for `f/[slugId].astro`.
3. In `publications.service.ts.update()` (or the publication-api.ts equivalent), `ctx.waitUntil(caches.default.delete(...))` on save.
4. Create `apps/web/src/components/{CommentsStatsBadge,PermissionsHint,WorkspaceMemberCount,LastEditedBy}.astro` as `server:defer` islands with skeleton fallback slots.
5. Wire `ASTRO_KEY` via `wrangler secret put` for cross-deploy prop encryption.
6. Add `apps/web/src/pages/img/[...key].ts` for R2 → IMAGES transform pipeline.
7. Run `pnpm typecheck` + `pnpm test` + browser smoke.

### Phase 9 — Performance polish (1 day)

1. Add per-page renderer flags (`has_code`, `has_mermaid`, `has_math`, `has_wardley`, `has_cytoscape`) to `pages` table — folded into 0001_init.sql in Phase 4 already.
2. Update markdown ingestion to walk the AST and set flags.
3. Renderer dynamic-imports plugins by flag.
4. Add `apps/web/src/scripts/{mermaid,katex,cytoscape,wardley}-lazy.ts` with IntersectionObserver.
5. Switch font `display` from `"block"` to `"swap"`. Narrow weights. Add `preload` on Geist body only.
6. Switch `imageService.runtime` from `"passthrough"` to `"cloudflare-binding"` in `astro.config.mjs`.

### Phase 10 — Security + observability + email (1 day)

1. Create `apps/web/src/lib/security-headers.ts`. Wire from middleware on HTML responses.
2. Create `apps/web/src/lib/email.ts` with the Resend `fetch` helper. Replace any `send_email` binding usage.
3. Update `apps/web/src/lib/email.ts` magic-link sender to call Resend.
4. Set up Sentry destination in the Cloudflare dashboard.
5. Add `console.log(JSON.stringify({...}))` structured logging at the 5 highest-traffic decision points (auth, save page, publish, MCP tool call, cron run).

### Phase 11 — Final scrub + verify (½ day)

1. `pnpm format`.
2. `pnpm typecheck` (expect 0 errors, 0 hints).
3. `pnpm test` (expect 100% pass).
4. `pnpm --filter @vegastack/pages-web build`. Inspect `dist/server/wrangler.json` and confirm it matches the checked-in `apps/web/wrangler.jsonc`.
5. Bundle-size check: `du -h dist/server/entry.mjs` — target < 1.5 MB.
6. Smoke test against local Node backend: cold start, create workspace, create page, edit page, publish, view at `/p/<slug>`, comment, resolve, favorite, move to folder. Every action should feel instant.
7. Update `install/cloudflare/wrangler.example.jsonc` to match the new canonical shape, with the ASCII architecture diagram (§11) at the top.
8. Update `CLAUDE.md` with the new canonical patterns + the ASCII diagram link.
9. Open the PR to `develop` (per CLAUDE.md branch model).

---

## 8. Testing strategy

### 8.1 Layer-by-layer

- **`packages/services/**`unit tests**: each service function gets a Vitest test running against an in-memory better-sqlite3 D1. Setup creates schema from`0001_init.sql`. ~80 tests covering happy paths + error paths + auth + concurrency.
- **`apps/web/src/actions/**` integration tests\*\*: render a minimal Astro context, call the action, assert the result. ~25 tests.
- **`apps/web/src/pages/api/**` integration tests\*\*: pre-existing test surface (~349 tests today) updated to the new envelope + AppError shape.
- **`apps/web/src/pages/p/[slugId].astro` cache test**: verify Workers Cache hit-then-miss-on-save invalidation. Use Miniflare's `caches` mock.
- **MCP tool test**: one end-to-end test per tool against the rewritten handlers.

### 8.2 Browser smoke checklist

After Phase 11, manually verify in Chrome:

1. Cold load `/`, `/app`, `/p/<slug>` — Lighthouse Performance score ≥ 90, LCP ≤ 2s on Fast 3G throttle.
2. Sidebar stays mounted across `/p/abc` → `/p/def` navigation (no remount, no flicker).
3. Save page — toast appears, sidebar count updates without full reload.
4. Public publish — `/p/<slug>` returns 200 with `cache-control` and `etag`. Second request from same colo is < 50ms.
5. MCP tool call from Claude — page is created, envelope present in response.
6. CLI `vpg page create` — uses REST `/api/*`, gets the same envelope.
7. Cron: trigger nightly GitHub backup with `wrangler dev --test-scheduled`.

### 8.3 Load test (optional but recommended)

Use `oha` or `k6` against a local Cloudflare adapter dev server:

- 50 concurrent page saves to the same workspace → no race, no lost writes, no batch interleaving.
- 100 concurrent reads to `/p/<slug>` → all served from `caches.default` after warmup.

---

## 9. Risks + mitigations

| Risk                                                                   | Likelihood      | Mitigation                                                                                                                                   |
| ---------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct-D1 services miss an atomicity case the lock used to cover       | Medium          | Every multi-step write in services uses `db.batch([...])`. Code review checklist: any service function with two awaits to `db.run` is a bug. |
| `wrangler types` doesn't pick up a new binding                         | Low             | `prebuild` runs `wrangler types && astro check`, so a missing binding fails CI.                                                              |
| Astro Actions surface diverges from `/api/*` and they get out of sync  | Medium          | Both call the same service functions. Service tests cover the canonical behavior; actions/routes are 3-line wrappers.                        |
| Workers Cache invalidation misses on save                              | Medium          | Compute the same key (`url#contentHash`) in both put and delete. Add a test that saves and re-fetches in the same request.                   |
| `transition:persist` causes React island state to leak across users    | Low             | Sidebar/PageHeader props include `workspaceId`/`pageId`; on prop change React re-renders. Test by switching between workspaces.              |
| Resend dependency adds latency at email send                           | Low             | Send is `ctx.waitUntil`-wrapped; user gets immediate response. Resend p95 < 200ms.                                                           |
| Squashed migration breaks self-hosters mid-flight                      | None (no users) | N/A. Document in CHANGELOG: "v1.0 is a clean-slate. To upgrade from 0.x, run `vpg export` then re-import on 1.0."                            |
| Bundle size grows                                                      | Medium          | Phase 11 includes a size check. Astro's `chunkSizeWarningLimit: 900` flags large chunks. Heavy libs are dynamic-imported.                    |
| Smart Placement causes unexpected latency for users far from D1 region | Low             | Placement is observed in the dashboard for the first week post-deploy. If problematic, set `mode: "off"` and re-evaluate.                    |
| Server Islands fail when `ASTRO_KEY` rotates mid-request               | Low             | Set `ASTRO_KEY` once per deploy; islands re-encrypt on next render.                                                                          |

---

## 10. Definition of done

The branch is mergeable to `develop` when ALL of:

- [ ] `pnpm format --check` exits 0.
- [ ] `pnpm typecheck` exits 0 with 0 hints.
- [ ] `pnpm test` exits 0 with at least 400 tests (~349 today + ~50 service unit tests added).
- [ ] `pnpm --filter @vegastack/pages-web build` exits 0 with no warnings.
- [ ] `dist/server/entry.mjs` is < 1.5 MB.
- [ ] `runtime.ts` is < 500 LOC.
- [ ] Zero references to `process.env.VPG_*` in `apps/web/src/**` (except inside `adapters/node/`).
- [ ] Zero references to `acquireRuntimeMutationLock`, `persistRuntimeState`, `hydrateRuntimeState`, `runtime_state`, `runtime_locks`.
- [ ] Zero references to `ServiceError`, `attachEnvelope`, `SessionHandle`, `api-client`, `target.ts`, `backend/index.ts`, `scripts/shell/`, `document-payload`.
- [ ] One canonical `apps/web/wrangler.jsonc` checked in.
- [ ] One `0001_init.sql` + one `0002_oauth_seed.sql` migration.
- [ ] Browser smoke checklist (§8.2) all green.
- [ ] CLAUDE.md updated with the canonical patterns.
- [ ] A changeset entry exists.

Once merged to `develop`, the changeset workflow publishes `vegastack-pages@1.0.0-next.0` to npm `next`. Smoke test the prerelease. Then tag `v1.0.0` on `main` for the `pages.vegastack.com` Cloudflare Worker deploy.

---

## 11. Final architecture diagram

```
                       ┌────────────────────────────────────┐
                       │  Browser  •  MCP client  •  CLI    │
                       └────────────────┬───────────────────┘
                                        │ HTTPS
                                        ▼
              ┌─────────────────────────────────────────────────────┐
              │       pages.vegastack.com (Cloudflare DNS)          │
              └────────────────────────┬────────────────────────────┘
                                       │
                       ┌───────────────┴───────────────┐
                       │   Cloudflare Edge             │
                       │   - Cache API (caches.default)│  ← /p/, /f/, /docs/
                       │   - Cloudflare Rate Limiting  │     keyed by url#hash
                       │   - WAF                       │
                       └───────────────┬───────────────┘
                                       │ cache miss
                                       ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  Single Cloudflare Worker  (placement: smart)                            │
   │  ─────────────────────────                                               │
   │  Astro 6.3 SSR  •  @astrojs/cloudflare 13.5  •  Wrangler 4               │
   │  compatibility_flags: ["nodejs_compat"]                                  │
   │  observability + tracing → Sentry (OTLP)                                 │
   │                                                                          │
   │  Routes:                                                                 │
   │    /                  marketing landing                                  │
   │    /docs/*            prerendered marketing docs                         │
   │    /p/[slug]          public published page  (Workers Cache)             │
   │    /f/[slug]          public folder index    (Workers Cache)             │
   │    /img/[...key]      R2 → IMAGES transform  (Workers Cache)             │
   │    /auth/magic-link   magic-link landing                                 │
   │    /oauth/*           OAuth canonical endpoints                          │
   │    /authorize, /token, /register, /revoke, /device   protocol shims      │
   │    /mcp               MCP HTTP transport                                 │
   │    /.well-known/*     OAuth discovery                                    │
   │    /app/*             authenticated app                                  │
   │       /app/login                                                         │
   │       /app/signup                                                        │
   │       /app/setup                                                         │
   │       /app/settings/{general,profile,members,folders,templates,...}      │
   │    /_actions/*        Astro Actions (browser mutations)                  │
   │    /api/*             REST surface (MCP + CLI)                           │
   │                                                                          │
   │  Middleware:    auth + CSRF + rate limit + security headers              │
   │  Service layer: packages/services/* (direct D1, no in-memory snapshot)   │
   │  Errors:        AppError (single hierarchy)                              │
   │  Mutations:     return MutationEnvelope for client cache invalidation    │
   │  Background:    Astro.locals.cfContext.waitUntil(...)                    │
   │  Cron:          nightly GitHub backup (triggers.crons)                   │
   └────┬────────────┬────────────┬────────────┬────────────┬──────────────┘
        │            │            │            │            │
        ▼            ▼            ▼            ▼            ▼
   ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐ ┌───────────────┐
   │ D1 (DB) │ │ R2       │ │ Images │ │ ACTIONS_ │ │ Resend HTTPS  │
   │         │ │ (CONTENT)│ │binding │ │ RL       │ │ (magic links) │
   │ - users │ │ - pages  │ │        │ │          │ │               │
   │ - works │ │ - vers   │ │        │ │ per-user │ │               │
   │ - pages │ │ - attach │ │        │ │ quotas   │ │               │
   │ - ...   │ │          │ │        │ │          │ │               │
   └─────────┘ └──────────┘ └────────┘ └──────────┘ └───────────────┘

   Browser navigation:
     • Astro <ClientRouter /> intercepts links + popstate
     • transition:persist on Sidebar, CommandPalette, CommentsRail,
       PageHeader, SonnerHost, MobileTabBar  → stay mounted across nav
     • Only <main id="vpg-document"> swaps on click
     • prefetch="hover" warms the next page

   Browser mutations:
     • Astro Actions (typed end-to-end, devalue serialization, PRG-safe)
     • Server Islands (server:defer) for CommentsStats, MemberCount, ...

   Env access (everywhere):
     • import { env } from "cloudflare:workers"   (bindings + secrets)
     • import { X } from "astro:env/server"       (typed plain vars)
     • Env type generated by `wrangler types`

   Heavy libs (Mermaid, KaTeX, Cytoscape, Wardley, Shiki):
     • Server: dynamic-imported per page based on has_* flags on pages row
     • Client: hydrated on IntersectionObserver, not at load

   Self-host (Node):
     • Same code base; apps/web/src/adapters/node/ provides
       NodeSqliteD1Database + FileObjectStore
     • Single Node process — no replication, no edge cache,
       same canonical service functions

   Removed compared to prior state:
     ✗ activeD1Batch + module-level mutable state
     ✗ acquireRuntimeMutationLock / persistRuntimeState / hydrate snapshot
     ✗ runtime_state + runtime_locks tables
     ✗ Custom shell controller          (ClientRouter does it)
     ✗ Two-Worker split + service binding (Smart Placement does it)
     ✗ ServiceError class               (AppError covers it)
     ✗ SessionHandle / D1 Sessions      (no replicas in v1)
     ✗ Astro.session + SESSION KV       (custom auth in D1)
     ✗ send_email binding               (Resend HTTPS)
     ✗ process.env reads                (cloudflare:workers env)
     ✗ VPG_ADAPTER env var              (VPG_RUNTIME only)
     ✗ Drizzle schema.ts                (hand-written row types)
     ✗ 20 of 21 migration files         (squashed to 0001_init.sql)
     ✗ Top-level /login, /signup, /setup, /profile, /admin
     ✗ /app/profile, /app/settings/sessions  legacy redirects
```

---

## 12. Total work estimate

| Phase     | Description                                | Effort         |
| --------- | ------------------------------------------ | -------------- |
| 0         | Branch hygiene                             | 0.5 day        |
| 1         | Routing relocation                         | 0.5 day        |
| 2         | Wrangler v4 + Astro 6 idiom                | 1 day          |
| 3         | Dead-code purge                            | 1 day          |
| 4         | Schema squash + Node adapter split         | 1.5 days       |
| 5         | Rewrite runtime.ts + services as direct-D1 | 3 days         |
| 6         | ClientRouter + transition:persist          | 0.5 day        |
| 7         | Astro Actions                              | 1.5 days       |
| 8         | Workers Cache + Server Islands             | 1 day          |
| 9         | Performance polish                         | 1 day          |
| 10        | Security + observability + email           | 1 day          |
| 11        | Final scrub + verify                       | 0.5 day        |
| **Total** |                                            | **~12.5 days** |

---

## 13. What to do if anything in this plan turns out to be wrong

Stop the phase, write a one-paragraph note in this file under a new "Deviation log" section at the bottom with: what we found, why the plan said X, what we did instead, and why. Don't silently diverge.

---

End of plan.
