# 007 — Instant Workspace Architecture (Astro + Cloudflare)

Status: Plan, awaiting implementation approval.
Owners: K Manoj Kumar.
Supersedes the draft at `Downloads/PLAN.md`.
Doc references inline; every load-bearing claim is doc-cited.

## 0. One-paragraph north star

Astro renders the first page. After that, the app behaves as a single document shell that swaps only document payloads and emits uniform mutation envelopes. The backend stops persisting whole-runtime snapshots and stops globally locking writes. On **Cloudflare managed** hosting, the Worker is split into an edge (Astro SSR + assets) and a backend (D1/R2/MCP/cron, Smart Placement on); MCP lives on the backend so agent traffic skips the SSR overhead; reads use D1 Sessions API + bookmarks against multi-region read replicas; public publication routes stay SSR with content-hash edge caching; authenticated HTML is never edge-cached. On **Node self-host**, the same services and repository layer run in a single process against SQLite + filesystem object store, with all the Cloudflare-only optimizations short-circuited to no-ops. One codepath, two runtimes.

## 0.5. Self-host vs managed hosting

VegaStack Pages is open-source. The plan must work for both deployment targets without forking the codebase. This section is the contract:

| Capability                                         | Managed (Cloudflare)                              | Self-host (Node)                                                             |
| -------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Astro adapter                                      | `@astrojs/cloudflare`                             | `@astrojs/node` (standalone)                                                 |
| HTTP topology                                      | Edge + Backend Worker via service binding         | **Single Node process** (in-process call)                                    |
| DB                                                 | D1 (`env.DB`)                                     | better-sqlite3 (`createNodeSqliteD1()`, already exists at `runtime.ts:1086`) |
| Object storage                                     | R2 (`env.CONTENT`)                                | filesystem under `.vegastack-pages/local` (already exists)                   |
| Sessions store                                     | KV (`env.SESSION`)                                | SQLite table                                                                 |
| Service binding (`env.API`)                        | Cloudflare service binding (`env.API.fetch(req)`) | Synchronous in-process import: `apiHandler(req)`                             |
| Smart Placement                                    | `placement: { mode: "smart" }` on backend         | No-op (irrelevant on single process)                                         |
| D1 Sessions API + bookmark                         | Enabled, returned in `x-vpg-d1-bookmark` header   | Always immediately consistent; bookmark header omitted                       |
| D1 read replicas                                   | NA + EU regions (paid plan)                       | N/A — single SQLite file                                                     |
| Edge cache for public pages                        | Cloudflare Cache API (`caches.default`)           | HTTP cache headers only (reverse proxy handles caching if present)           |
| Cron                                               | `triggers.crons` in backend Wrangler              | `node-cron` started by `apps/web/src/server.ts` boot                         |
| Email                                              | `send_email` binding                              | SMTP via existing email provider abstraction                                 |
| Server Islands (`server:defer`)                    | Works (adapter-supported)                         | Works (adapter-supported)                                                    |
| Shell controller + payload API + mutation envelope | **Same code, same behaviour**                     | **Same code, same behaviour**                                                |
| Narrow repository layer + lock removal             | **Same code, same behaviour**                     | **Same code, same behaviour**                                                |
| `packages/services`                                | **Same code, same behaviour**                     | **Same code, same behaviour**                                                |
| MCP perf                                           | Direct hit to backend Worker                      | Direct hit to local server                                                   |

**Runtime detection** is centralized in `apps/web/src/lib/runtime/target.ts`:

```ts
export type RuntimeTarget = "cloudflare-edge" | "cloudflare-api" | "node";
export function detectTarget(env: Env): RuntimeTarget {
  if (typeof env?.DB?.withSession === "function")
    return env.API ? "cloudflare-edge" : "cloudflare-api";
  return "node";
}
```

Everywhere the plan says "edge Worker calls backend via `env.API.fetch(req)`", the same call site falls back to `apiHandler(req)` (the same imported function) on Node. Same for `withSession`: if absent, return a wrapper that just executes statements on `env.DB` directly. Cloudflare's optimizations short-circuit to cheap defaults on Node; no `if (target === "node")` branches scattered through the code.

**Managed-hosting fastest path** (the user's stated goal) is preserved because every Cloudflare-only optimization (Smart Placement, replicas, Sessions API, edge cache, KV Sessions, content-hash immutable caching, service binding split) only kicks in when the runtime supports it. Self-host gets the architectural wins (narrow writes, no lock, shell, server islands, lazy hydration, mutation envelope, `packages/services`) without any of the Cloudflare dependencies.

## 1. Decisions log (from clarification rounds)

| #   | Decision           | Choice                                                                                         |
| --- | ------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | Worker topology    | **Split**: edge (SSR+assets, no placement) + backend (D1/R2/MCP, Smart Placement on)           |
| 2   | Phase-1 work       | **All three tracks in parallel**: backend rewrite, Server Islands, shell+payload               |
| 3   | D1 tier            | **Paid plan**, read replicas in NA + EU (2-3 regions), Sessions API + bookmarks                |
| 4   | ClientRouter       | **Remove entirely**; shell owns `/p/*` and `/f/*`, rest is normal nav                          |
| 5   | Shell DOM topology | **Three persistent zones**: sidebar, header+breadcrumb, `<main id="vpg-document">` swap zone   |
| 6   | Mutation envelope  | **All nav-affecting POSTs in one PR**, includes comments                                       |
| 7   | Tests              | **Add Playwright** for `/p/*` `/f/*` flows + Vitest for unit/API                               |
| 8   | CSS                | **Move to `AppLayout`** (`docs.css`, `comments.css`, prose)                                    |
| 9   | Auth/session       | **Edge validates**, passes signed actor header to backend                                      |
| 10  | Server Islands     | **Comments stats**, **Favorite**, **Permissions hint** become `server:defer`                   |
| 11  | CLI/MCP services   | **Build `packages/services` in v1** — agent perf is critical                                   |
| 12  | Island hydration   | CommandPalette: `client:idle` + dynamic open. CommentsRail: `client:idle`, full panel on open  |
| 13  | MCP placement      | **Backend Worker only**, bypass edge for agent traffic                                         |
| 14  | Smart Placement    | **Enable day-1** on backend Worker with `placement_status` monitoring                          |
| 15  | Public routes      | **SSR-only**, content-hash edge cache (`Cache-Control: public, immutable`)                     |
| 16  | Legacy data        | **One-shot migration**: drain `runtime_state` row → normalized tables → drop row               |
| 17  | Local dev          | **Single Node process**, route-prefix multiplex; production = two real Workers                 |
| 18  | Cron               | **Backend Worker** owns the GitHub sync cron                                                   |
| 19  | Replicas           | **2–3 regions** (NA + EU), Sessions API on top                                                 |
| 20  | Secrets            | Generate `ASTRO_KEY` now, store in `cloudflare-prod` env; grep + clean any stale MCP tool refs |

## 2. Diagnosis (doc-grounded)

The audit confirmed three concrete root causes in `apps/web`:

1. **Whole-runtime snapshot persist on every mutation.** `apps/web/src/middleware.ts:158-178` acquires a global lock, runs the handler, and on success calls `persistRuntimeState()`. `persistNormalizedRuntimeStateBatch()` at `apps/web/src/lib/runtime.ts:2347-2410+` reads every map of every service (users, workspaces, members, folders, pages, versions, grants, magicLinks, sessions, threads, anchors, replies, publications, attachments, favorites, searchDocuments) and writes them in one D1 batch. With D1's free-tier 1,000-statement batch limit (`cloudflare/.../d1/README.md:72-82`), the current pattern is one bad workspace away from total write failure.
2. **Module-level mutable service state.** The runtime maps in `runtime.ts` are mutated by handlers and then re-serialized. Cloudflare flags this exactly: `workers-best-practices/SKILL.md:74` — "Never store request-scoped data in module-level variables." Cross-request data-leak risk, not just a perf problem.
3. **Eager `client:load` islands + route-owned CSS + ClientRouter remount churn.** `apps/web/src/pages/p/[slugId].astro:36-37, 1034, 1166, 1181` imports `docs.css`+`comments.css` route-locally; CommandPalette and CommentsRail are `client:load`; `astro:page-load` re-inits everything on every nav. View-transitions docs (`view-transitions.mdx:540`) confirm bundled scripts only execute once — the lifecycle pattern in the code is correct, but the eager hydration + route-owned CSS guarantee jank on partial swaps.

Astro 6 docs (`guides/view-transitions.mdx:39`) explicitly de-emphasize ClientRouter going forward. Plan 007 removes it from `/p/*` and `/f/*`.

## 3. Target architecture

```
                       ┌───────────────────────────┐
                       │ Edge Worker (vpg-edge)    │
                       │ • Astro SSR + assets       │
                       │ • Auth: KV SESSION lookup  │
                       │ • Shell controller served  │
                       │ • Public pages SSR + cache │
                       │ • placement: off           │
                       └────────┬──────────────────┘
                                │ Service binding (RPC)
                                │ signed actor header
                                ▼
                       ┌───────────────────────────┐
                       │ Backend Worker (vpg-api)  │
                       │ • /api/*                   │
                       │ • /mcp                     │
                       │ • Cron (GH sync)           │
                       │ • Narrow repository writes │
                       │ • Sessions API + bookmark  │
                       │ • placement: smart         │
                       └──┬────────────────┬───────┘
                          │                │
                          ▼                ▼
                        D1 primary       R2 CONTENT
                        + replicas       (source + rendered HTML)
                          NA, EU
```

Two Workers, one service binding, one shell architecture, one repository layer.

## 4. Workstream A — Backend repository layer + lock removal

Goal: kill the global mutation lock and `persistNormalizedRuntimeStateBatch`; make writes narrow, fast, and concurrent.

### A.1 Files to touch

- `apps/web/src/lib/runtime.ts` — split into `runtime/bootstrap.ts`, `runtime/repository.ts`, and per-resource modules. Keep the same exported names initially to minimize diff churn at call sites; alias new functions to old names.
- `apps/web/src/middleware.ts` — drop `acquireRuntimeMutationLock`; drop `persistRuntimeState()`; move `pruneExpiredVersions()` and search indexing into `ctx.waitUntil()` from route handlers, not middleware.
- `apps/web/src/lib/github-backup.ts:1196,1224,1239` — replace `persistRuntimeState()` calls with the narrow writes for the specific resources each one mutates.
- `apps/web/src/pages/api/auth/{dev-login,signup,logout,magic-link/verify}.ts` and `apps/web/src/pages/api/workspaces/[workspaceId]/github-backup.ts` and `apps/web/src/pages/api/integrations/github/callback.ts` and `apps/web/src/pages/mcp.ts:264` — same: replace bulk persist with narrow write.

### A.2 Repository contract

Each resource (page, version, folder, comment-thread, anchor, reply, permission-grant, publication, favorite, attachment, session, magic-link, search-doc, workspace, member, audit-log) gets a module under `apps/web/src/lib/repo/` exposing:

```ts
export type PageRepo = {
  getById(id: string): Promise<PageRecord | null>;
  getBySlugId(slugId: string): Promise<PageRecord | null>;
  listInFolder(
    workspaceId: string,
    folderId: string | null,
  ): Promise<PageRecord[]>;
  create(input: NewPage): Promise<PageRecord>;
  updateSource(id: string, patch: SourcePatch): Promise<PageRecord>;
  restoreVersion(id: string, versionId: string): Promise<PageRecord>;
  rename(id: string, title: string, slug: string): Promise<PageRecord>;
  move(
    id: string,
    toFolderId: string | null,
    position: number,
  ): Promise<PageRecord>;
  softDelete(id: string): Promise<void>;
  hardDelete(id: string): Promise<void>; // cleanup only
};
```

Each method runs the **narrowest possible D1 statements** for that operation; no shared cross-resource state. No batched whole-table re-serialization.

### A.3 D1 Sessions API + bookmark wiring

Per `cloudflare/.../d1/README.md:62-70` and `workers/gotchas.md:38-44`:

```ts
// Backend Worker fetch handler
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const bookmark = req.headers.get("x-vpg-d1-bookmark") ?? undefined;
    const session = env.DB.withSession(bookmark); // primary D1
    // reads can hit DB_REPLICA via session.withSession() bookmark replay
    const ctxObj = { env, ctx, session, replica: env.DB_REPLICA };
    const res = await router(req, ctxObj);
    if (session.getBookmark())
      res.headers.set("x-vpg-d1-bookmark", session.getBookmark()!);
    return res;
  },
};
```

Edge Worker stores the bookmark in `sessionStorage` keyed by workspace; replays on every request.

### A.4 Background work

`ctx.waitUntil()` covers (per `workers-best-practices/references/rules.md:144-167`, **never destructure `ctx`**):

- `pruneExpiredVersions()` after version writes.
- Search index updates (`searchService.documents`).
- Audit log fanout where the consumer is non-critical.
- GitHub sync notification webhooks.

Auth writes (sessions, rate limits, magic links) **stay synchronous**. Per the doc rule, only non-critical post-response work is allowed in `waitUntil`.

### A.5 Legacy migration (decision #16)

One coordinated deploy:

1. Pre-deploy: `wrangler d1 execute vegastack_pages_prod --remote --command="SELECT json FROM runtime_state WHERE key='default'"` to confirm the row exists.
2. Migration file in `packages/db/migrations/` — script-style: read `runtime_state` row if present, upsert into normalized tables, delete the row, drop the `runtime_state` table.
3. Deploy backend with new code that never reads/writes `runtime_state`.
4. ~30 s read-only window during deploy (acceptable).

### A.6 Batch-size guardrail

Before the rewrite ships, add `console.log({batchSize})` around the current `persistNormalizedRuntimeStateBatch` for 24 h. If p95 > 800 statements, the free-tier 1,000-cap is one comment away from breaking prod and the rewrite is urgent. Paid tier raises this to 10,000 (see `d1/README.md:72-82`) but narrowing writes is still correct.

### A.7 Module-level state cleanup (doc-cited)

The in-memory service maps (`pageService`, `workspaceService`, etc. in `runtime.ts`) violate `workers-best-practices/SKILL.md:74`. Remove them as the source of truth; D1 is the source of truth. Keep a per-request **request-scoped cache** if needed (a `Map` created inside `fetch()` and discarded with the request) — not module-level.

## 5. Workstream B — Worker split (edge + backend)

### B.1 New wrangler topology

`apps/web/wrangler.frontend.jsonc` (edge Worker, no placement, has ASSETS):

```jsonc
{
  "name": "vegastack-pages-edge",
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2026-05-10",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "binding": "ASSETS", "directory": "./dist/client" },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "logs": {
      "enabled": true,
      "invocation_logs": true,
      "persist": true,
      "head_sampling_rate": 1,
    },
  },
  "kv_namespaces": [{ "binding": "SESSION", "id": "<existing>" }],
  "services": [{ "binding": "API", "service": "vegastack-pages-api" }],
  "vars": {
    "VPG_RUNTIME": "cloudflare-edge",
    "VPG_DEPLOYMENT_MODE": "self_hosted",
  },
}
```

`apps/web/wrangler.backend.jsonc` (backend Worker, Smart Placement on, holds D1/R2):

```jsonc
{
  "name": "vegastack-pages-api",
  "main": "./dist/backend/index.js",
  "compatibility_date": "2026-05-10",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "placement": { "mode": "smart" },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "logs": {
      "enabled": true,
      "invocation_logs": true,
      "persist": true,
      "head_sampling_rate": 1,
    },
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "vegastack_pages_prod",
      "database_id": "e85aea0b-8068-430a-a2b6-53a74dc591e6",
      "migrations_dir": "../../packages/db/migrations",
    },
    {
      "binding": "DB_REPLICA",
      "database_name": "vegastack_pages_prod",
      "database_id": "e85aea0b-8068-430a-a2b6-53a74dc591e6",
      "experimental_remote": true,
    },
  ],
  "r2_buckets": [
    { "binding": "CONTENT", "bucket_name": "vegastack-pages-content" },
  ],
  "send_email": [{ "name": "EMAIL" }],
  "triggers": { "crons": ["17 2 * * *"] },
  "vars": {
    "VPG_RUNTIME": "cloudflare-api",
    "VPG_DEPLOYMENT_MODE": "self_hosted",
  },
}
```

Service binding from edge to backend per `workers-best-practices/references/rules.md:218-238`. Edge calls backend via `env.API.fetch(req)` for `/api/*` and signs an `x-vpg-actor` header with the validated session identity (HMAC over user_id + nonce + ts using `VPG_INTERNAL_KEY` secret).

### B.2 Smart Placement on backend

Per `cloudflare/.../smart-placement/gotchas.md`: backend Worker has **no static assets**, **no `run_worker_first`**, and makes multiple D1/R2 calls per request — exactly the doc-recommended shape. Set `placement: { mode: "smart" }` on day-1 deploy.

Monitoring:

```bash
# 15 min after deploy, then 24 h
curl -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/services/vegastack-pages-api" \
  | jq .result.placement_status
```

Expected: `SUCCESS`. If `UNSUPPORTED_APPLICATION`, set `mode: "off"` and re-evaluate; if `INSUFFICIENT_INVOCATIONS`, leave 24h and re-check.

### B.3 Auth/session at edge (decision #9)

Edge middleware validates session from KV (`SESSION` binding) and constructs an internal actor header:

```ts
const sig = await crypto.subtle.sign(
  { name: "HMAC", hash: "SHA-256" },
  internalKey,
  encoder.encode(`${userId}|${nonce}|${ts}`),
);
req.headers.set("x-vpg-actor", `${userId}.${nonce}.${ts}.${b64(sig)}`);
```

Backend verifies HMAC and treats the actor as canonical. No KV lookup on backend (saves an eventual-consistency hop, per `cloudflare.mdx:340-358` KV is eventually consistent up to 60 s).

`VPG_INTERNAL_KEY` stored via `wrangler secret put` per `workers-best-practices/SKILL.md:46`.

### B.4 Local dev + Node self-host (decision #17, §0.5)

`pnpm dev --port 4322` runs ONE Node process. This is **also the production shape for self-hosters**, not just a dev convenience. `apps/web/src/lib/api-client.ts` picks the call mechanism at request time based on the runtime target:

```ts
// apps/web/src/lib/api-client.ts
import { detectTarget } from "./runtime/target";

export async function apiCall(req: Request, env: Env): Promise<Response> {
  const target = detectTarget(env);
  if (target === "cloudflare-edge") return env.API.fetch(req); // service binding
  // node and cloudflare-api (when reached directly): in-process call
  const { default: handler } = await import("../../backend/index");
  return handler.fetch(req, env, executionContextFor(target));
}
```

Cloudflare production: edge dispatches `/api/*` to backend via service binding. Node self-host: same function executes in-process, identical bytes. No code branches outside `apiCall`.

### B.5 Build pipeline

- `pnpm --filter @vegastack/pages-web build` produces `dist/_worker.js/` (edge) and `dist/backend/` (backend).
- `apps/web/scripts/build-backend.mjs` — small esbuild step that bundles the backend entry (`apps/web/backend/index.ts`) for workerd.
- Two wrangler deploys in `.github/workflows/release.yml`: backend first, then edge (so the service binding's referenced worker exists before edge deploys).

## 6. Workstream C — Document payload contract & shell

### C.1 `buildDocumentPayload` (decision #5)

`apps/web/src/lib/document-payload.ts`:

```ts
export type DocumentPayload = {
  kind: "page" | "folder";
  workspace: { id: string; slug: string; name: string };
  page?: {
    id: string;
    slug_id: string;
    title: string;
    source_type: "markdown" | "mdx" | "html";
    content_hash: string;
    version_id: string;
  };
  folder?: { id: string; slug_id: string; name: string };
  header: { title: string; metaHtml: string };
  breadcrumb: {
    items: Array<{
      id: string;
      kind: "workspace" | "folder" | "page";
      href: string;
      label: string;
    }>;
  };
  document_html: string; // rendered prose (or folder list HTML)
  toc: Array<{ id: string; level: number; text: string }>;
  comments_stats: {
    open: number;
    resolved: number;
    last_activity_at: string | null;
  };
  favorite: boolean;
  permissions: {
    canView: boolean;
    canEdit: boolean;
    canComment: boolean;
    canAdmin: boolean;
  };
  publication?: {
    status: "draft" | "published";
    url: string | null;
    visibility: "private" | "link" | "public";
  };
  tree_version: number;
  feature_chunks: Array<"mermaid" | "katex" | "cytoscape" | "wardley">; // shell knows what to lazy-load
  cache_control: "private, no-store";
};

export async function buildDocumentPayload(
  ref: { kind: "page" | "folder"; ref: string },
  actor: Actor,
  repo: Repo,
): Promise<DocumentPayload>;
```

Note: **JSON API endpoint, not Astro page partial.** Astro page partials strip scoped styles/scripts (`astro-js-docs/.../basics/astro-pages.mdx:142`), so the existing `[slugId].astro` cannot be repurposed as a partial. The JSON shape above is the contract; SSR routes and the partial endpoint both call `buildDocumentPayload()`.

### C.2 Routes

- `GET /api/workspaces/:workspaceId/documents/page/:ref` — returns `DocumentPayload` for a page by slug or `pg_*` id.
- `GET /api/workspaces/:workspaceId/documents/folder/:ref` — same for folders.
- `apps/web/src/pages/p/[slugId].astro` — refactored to call `buildDocumentPayload()` and render server-side. Same builder, same fields.
- `apps/web/src/pages/f/[slugId].astro` — same.

### C.3 Shell controller

`apps/web/src/scripts/shell/index.ts` — single vanilla TS module loaded by `AppLayout.astro`:

```ts
type ShellState = {
  workspaceId: string;
  pageContext: PageContext | FolderContext;
  controllers: {
    editor: EditorController;
    comments: CommentsController;
    palette: CommandPaletteController;
    pageActions: PageActionsController;
    share: ShareController;
  };
};

export function bootShell(initial: DocumentPayload) {
  const state: ShellState = {
    /* ... */
  };
  interceptInternalLinks(handleNavigate);
  bindBackForward(handlePopState);
  window.__vpgShell = { navigate: handleNavigate, getState: () => state };
}

async function handleNavigate(href: string, opts?: { replace?: boolean }) {
  const payloadUrl = toPayloadUrl(href);
  const res = await fetch(payloadUrl, {
    headers: { "x-vpg-d1-bookmark": readBookmark() },
  });
  if (!res.ok) {
    window.location.assign(href);
    return;
  } // full-page fallback
  saveBookmark(res.headers.get("x-vpg-d1-bookmark"));
  const payload: DocumentPayload = await res.json();
  await ensureFeatureChunks(payload.feature_chunks);
  swapDocument(payload);
  history[opts?.replace ? "replaceState" : "pushState"]({ payload }, "", href);
  document.title = payload.header.title;
  state.controllers.editor.bind(payload);
  state.controllers.comments.bind(payload);
  state.controllers.pageActions.bind(payload);
}

function swapDocument(payload: DocumentPayload) {
  const main = document.getElementById("vpg-document")!;
  main.innerHTML = payload.document_html;
  document.getElementById("vpg-breadcrumb")!.innerHTML = renderBreadcrumb(
    payload.breadcrumb,
  );
  document.getElementById("vpg-header-meta")!.innerHTML =
    payload.header.metaHtml;
  enhanceProse(); // reuses existing function
  initTocRail(); // reuses existing function
  initHtmlPreviewResize();
}
```

Link interception rules (decision #4):

- Same-origin only.
- Path matches `/p/[^/]+` or `/f/[^/]+`.
- No `target`, no `download`, no modifier keys (`ctrl/cmd/shift/alt/middle-click`).
- Not inside a form.
- If any rule fails → let the browser navigate normally (full-page).

`history.popstate` replays from `event.state.payload` when present; otherwise refetches. No competing routers — ClientRouter is removed.

### C.4 Persistent shell DOM (decision #5)

`apps/web/src/layouts/AppLayout.astro` is the only place that owns top-level structure:

```astro
<body>
  <aside id="vpg-sidebar">{/* sidebar tree, mounted once */}</aside>
  <header id="vpg-header">
    <nav id="vpg-breadcrumb"></nav>
    <div id="vpg-header-meta"></div>
  </header>
  <main id="vpg-document">{/* SSR-rendered first-page content */}</main>
  <aside id="vpg-comments-rail">{/* mounted once */}</aside>
  <div id="vpg-toast-host">{/* SonnerHost */}</div>
  <CommandPalette client:idle />
</body>
```

`<ClientRouter />` is removed. `transition:persist` is not used (ClientRouter directive). The shell controller is the only swap mechanism.

### C.5 CSS migration (decision #8)

Move from route to layout:

- `apps/web/src/styles/docs.css` → imported in `AppLayout.astro`.
- `apps/web/src/styles/comments.css` → imported in `AppLayout.astro`.
- `apps/web/src/pages/p/[slugId].astro:36-37` — drop the imports.
- `apps/web/src/pages/f/[slugId].astro:35` — drop the import.

Existing `inlineStylesheets: "auto"` in `apps/web/astro.config.mjs:103` keeps critical CSS inline; the rest stay as `<link>` references. No specificity changes expected (audit during implementation).

### C.6 Mutation envelope (decision #6)

All nav-affecting writes return:

```jsonc
{
  // ...existing response fields,
  "envelope": {
    "tree_version": 17,
    "content_hash": "sha256:...", // when a doc changed
    "navigation_invalidated": true, // tree shape changed
    "changed_resources": [
      "page:pg_abc",
      "folder:fl_xyz",
      "comments_stats:pg_abc",
      "favorite:pg_abc:usr_123",
    ],
  },
}
```

Routes that get the envelope (all in one PR):

- `/api/pages/[pageId]/source.ts`
- `/api/pages/[pageId]/patch.ts`
- `/api/pages/[pageId].ts` (rename / move / delete / restore)
- `/api/pages/[pageId]/favorite.ts`
- `/api/folders/[folderId]/*` (create, rename, move, delete, reorder)
- `/api/comment-threads/*` (create, resolve, anchor update — emits `comments_stats:<page>`)
- `/api/publications/*` (visibility, password)
- `/api/workspaces/[workspaceId]/members/*` (invite, role, removal)
- `/api/workspaces/[workspaceId]/permissions/*`
- `/api/templates/*` (create-page-from-template → envelope for the new page)
- `/api/workspaces/[workspaceId]/github-backup.ts` (GitHub sync writes)

Shell consumes `changed_resources` to invalidate its cache; sidebar refetches on `tree_version` bump.

## 7. Workstream D — Server Islands (decision #10)

Per `astro-js-docs/.../guides/server-islands.mdx`:

- `apps/web/src/components/CommentsStatsBadge.astro` — `server:defer`, takes `{ pageId }`, returns `{open, resolved}` counts.
- `apps/web/src/components/FavoriteButton.astro` — `server:defer`, per-user state.
- `apps/web/src/components/PermissionsHint.astro` — `server:defer`, returns role chip + share-button visibility.

Each accepts a `Cache-Control: private, no-store` header. Each is included in `[slugId].astro`'s SSR template; first paint shows fallback content (skeleton) until the deferred contents arrive.

`ASTRO_KEY` generated via `astro create-key`, stored as Cloudflare secret in `cloudflare-prod`:

```bash
wrangler secret put ASTRO_KEY --env production
```

Required for rolling deploys per `server-islands.mdx:107-121`.

After shell-nav, the deferred islands' state moves with the document payload (`comments_stats`, `favorite`, `permissions` are in `DocumentPayload`); the `server:defer` mechanism is only used on first SSR load. The shell's bind step writes the new values directly into the persisted DOM elements.

## 8. Workstream E — Lazy hydration (decision #12)

- `apps/web/src/pages/p/[slugId].astro:1181` and `apps/web/src/pages/f/[slugId].astro:368` — `CommandPalette client:load` → `CommandPalette client:idle`.
- `apps/web/src/pages/p/[slugId].astro:1166` and `:1034` — `CommentsRail client:load` → `CommentsRail client:idle`. The full `CommentsPanel.tsx` (~1100 lines) becomes a dynamic import inside `CommentsRail` triggered on first open.
- `apps/web/src/scripts/page-editor-controller.ts:62-64` — pattern already correct; no change.
- Mermaid / KaTeX / Cytoscape / Wardley remain on dynamic imports triggered by `enhanceProse()` detecting their tokens in the rendered HTML.

### E.1 Network assertion (Playwright, decision #7)

`apps/web/tests/e2e/navigation.spec.ts`:

```ts
test("normal /p nav does not load heavy chunks", async ({ page }) => {
  const heavy = /codemirror|mermaid|cytoscape|katex|wardley/;
  const loaded: string[] = [];
  page.on("request", (r) => {
    if (heavy.test(r.url())) loaded.push(r.url());
  });
  await page.goto("/p/sample-page");
  await page.click('a[href="/p/sample-page-2"]');
  await page.waitForLoadState("networkidle");
  expect(loaded).toEqual([]);
});
```

## 9. Workstream F — `packages/services` (decision #11)

Critical for agent perf. Today MCP runs through Astro middleware which includes the global lock; every tool call eats that.

### F.1 New package layout

`packages/services/src/`:

```
index.ts                     // public exports
context.ts                   // ServiceContext (repos, actor, env)
errors.ts                    // AppError + http mappings
documents.service.ts         // getDocumentPayload, getPage, getFolder, listTree
mutations.service.ts         // createPage, patchPage, restoreVersion, ...
comments.service.ts          // create, resolve, anchor update, list
publications.service.ts      // apply, delete, visibility
templates.service.ts         // CRUD + render + create-page-from
workspaces.service.ts        // list, invite, member role, remove
search.service.ts            // search workspace
review.service.ts            // wait-for-review, list-review-events
```

Each service takes a `ServiceContext` (`{ repo, actor, env, waitUntil, session }`) and returns plain data + `MutationEnvelope`. No HTTP knowledge inside services; no D1 calls outside `repo`.

### F.2 Consumers

- `apps/web/src/pages/api/**` route handlers — thin adapters: parse request, call service, attach envelope, return JSON.
- `apps/web/src/pages/mcp.ts` — replaces the current in-process service-map access with `services.*` calls. **MCP no longer mutates module-level state.** Lives on backend Worker (decision #13).
- `cli/vegastack-pages` — calls go over HTTP to the backend Worker. Each subcommand maps to one service method via the public REST API; we extract a small TypeScript client (`packages/services/src/client.ts`) and emit Rust bindings from it via codegen (or hand-port — small surface).

### F.3 MCP placement (decision #13, refined per user direction)

**Single hostname, no CORS.** Edge Worker handles all incoming traffic on `pages.vegastack.com`. Edge matches `/api/*` and `/mcp` and forwards via Service Binding (`env.API.fetch(req)`) to the backend Worker; the backend never has a public hostname. Result: agents call `https://pages.vegastack.com/mcp`, browsers call `https://pages.vegastack.com/api/*`, both land on edge first and forward in-process. No CORS, no DNS work, no api subdomain.

Edge `/api/*` and `/mcp` handler:

```ts
// apps/web/src/middleware.ts (replacement)
if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
  const signed = await signActorHeader(context, env.VPG_INTERNAL_KEY);
  const forwarded = new Request(context.request, {
    headers: new Headers([...context.request.headers, ["x-vpg-actor", signed]]),
  });
  return env.API.fetch(forwarded); // Service Binding RPC; Node fallback: in-process call
}
```

With Smart Placement on backend, MCP requests run close to D1. Edge stays tiny and edge-local.

### F.4 CLI/MCP parity (decision #20)

Every MCP tool maps to one service method:

```
create_page           -> mutations.service.createPage
update_page           -> mutations.service.updateSource
patch_page            -> mutations.service.patchPage
get_page              -> documents.service.getPage
list_page_versions    -> mutations.service.listVersions
create_page_snapshot  -> mutations.service.snapshot
restore_page_version  -> mutations.service.restoreVersion
upload_attachment     -> attachments.service.upload
wait_for_review       -> review.service.wait
list_comments         -> comments.service.list
create_comment        -> comments.service.create
update_thread         -> comments.service.updateThread
update_comment_anchor -> comments.service.updateAnchor
delete_thread         -> comments.service.deleteThread
list_review_events    -> review.service.list
publication_apply     -> publications.service.apply
publication_delete    -> publications.service.delete
search_workspace      -> search.service.search
list_workspace        -> workspaces.service.listTree
move_page             -> mutations.service.move
invite_workspace_member -> workspaces.service.invite
list_templates        -> templates.service.list
get_template          -> templates.service.get
create_template       -> templates.service.create
update_template       -> templates.service.update
render_template       -> templates.service.render
create_page_from_template -> templates.service.createPageFromTemplate
list_workspaces       -> workspaces.service.list
whoami                -> workspaces.service.whoami
```

CLI's `cli/vegastack-pages/src/main.rs` subcommands stay; they hit the same REST endpoints which thin-wrap the same services. No behaviour change to existing CLI surface.

### F.5 MCP stale-references cleanup (decision #20)

During implementation, run:

```bash
rg -n "old_tool_name|deprecated|legacy_tool" docs/ CHANGELOG.md README.md packages/mcp/
```

I found no stale references in the survey, but the grep is cheap and the user's expectation is that I verify. If clean, drop the bullet from the plan. If anything appears, remove the dead reference in the same PR as the MCP placement change.

## 10. Workstream G — Public publication routes (decision #15)

`apps/web/src/pages/public/[publicationSlug]/*` (current public publication routes):

- Stay SSR-only. **No shell. No transition:persist. No ClientRouter** (already removed globally).
- Response sets:
  ```
  Cache-Control: public, max-age=31536000, immutable
  ETag: "<content-hash>"
  ```
- Cache key: URL with content-hash. When a publication is republished, the published URL itself carries the new content-hash segment (e.g. `/p/<slug>?v=<hash>` or a path component), so the previous URL stays cached and new visitors get the new URL.
- Cloudflare Cache API (`caches.default`) caches by URL + Vary. Authenticated workspace `/p/*` is `Cache-Control: private, no-store` and never edge-cached. Public publication is `Cache-Control: public, immutable` and edge-cached.
- Edge purge by content-hash, not slug: `wrangler` cache-purge or Cloudflare API on republish.

## 11. Workstream H — Tests (decision #7)

### H.1 Playwright setup

`apps/web/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://127.0.0.1:4322" },
  webServer: {
    command: "pnpm dev:local -- --port 4322",
    port: 4322,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  reporter: [["html", { open: "never" }], ["list"]],
});
```

`apps/web/package.json` deps: `@playwright/test ^1.49.0`.

### H.2 E2E suites (gate in CI)

- `tests/e2e/navigation.spec.ts` — no full reload on `/p` ↔ `/p` and `/f` ↔ `/p`, CSS persistent, no heavy-chunk load on normal nav.
- `tests/e2e/edit-save.spec.ts` — edit toggle → save → rendered HTML updates without reload.
- `tests/e2e/restore.spec.ts` — restore version → content + sidebar + breadcrumb update in place.
- `tests/e2e/comments.spec.ts` — open rail, submit comment, optimistic appears once, anchored to selection.
- `tests/e2e/mobile-comments.spec.ts` — `iPhone 14` viewport, comment opens on first tap.
- `tests/e2e/command-palette.spec.ts` — Ctrl/Cmd+K after 3 navigations still opens.
- `tests/e2e/share.spec.ts` — share dialog lazy-loads, handles network failure visibly.
- `tests/e2e/favorite.spec.ts` — toggle updates header/sidebar instantly.
- `tests/e2e/mcp-perf.spec.ts` — fires 10 concurrent `update_page` MCP calls; expects p95 < 500 ms (proves the lock is gone). Uses the same backend the browser hits, asserting agent-class throughput.

### H.3 Vitest

- `apps/web/src/pages/api/_tests/` — keeps existing API tests; adds envelope shape assertions.
- `packages/services/src/__tests__/` — service-level unit tests with an in-memory repo mock.
- `apps/web/src/lib/__tests__/document-payload.test.ts` — payload parity: same `DocumentPayload` whether constructed from SSR route or `/api/.../documents/page/:ref`.
- `apps/web/src/lib/__tests__/mutation-envelope.test.ts` — every nav-affecting POST returns the envelope (table-driven test).
- `apps/web/src/lib/__tests__/repo-narrow.test.ts` — narrow writes don't touch unrelated tables.
- `apps/web/src/lib/__tests__/d1-batch-budget.test.ts` — assert no write goes through > 50 D1 statements.

### H.4 Release-time checks (already in CLAUDE.md)

- `pnpm typecheck`
- `pnpm test`
- `pnpm --filter @vegastack/pages-web build`
- `wrangler check startup --config apps/web/wrangler.backend.jsonc`
- `wrangler check startup --config apps/web/wrangler.frontend.jsonc`

## 12. Workstream I — D1 read replicas + Sessions (decisions #3, #19)

Per `cloudflare/.../d1/README.md:62-70` and `d1/patterns.md:130-180`:

1. Upgrade D1 to paid plan (account-level, prerequisite).
2. Enable read replication on `vegastack_pages_prod` in 2 initial regions (NA + EU; pick `weur` and `wnam` or matching). One command per region via Cloudflare API.
3. Add `DB_REPLICA` binding in `wrangler.backend.jsonc` (same DB id, `experimental_remote: true` per current schema).
4. Backend handler creates a `session = env.DB.withSession(bookmark)`; reads can hit replica via session bookmark replay; writes always go to primary.
5. Response includes `x-vpg-d1-bookmark`; edge stores it in `sessionStorage`; subsequent requests echo it back.
6. Edit/restore/comment writes return the new bookmark synchronously; the next read on the same session is guaranteed to see the write (per `workers/gotchas.md:38-44`).

## 13. Workstream J — Astro config alignment

`apps/web/astro.config.mjs`:

- Remove the `<ClientRouter />` import path from `apps/web/src/layouts/AppLayout.astro:3-4, 64`.
- Keep `prefetch: { prefetchAll: false, defaultStrategy: "hover" }` for `<a>` tags outside `/p/*`. Shell handles its own prefetching for sidebar links via `apps/web/src/scripts/shell/prefetch.ts` (programmatic `fetch` on hover, no `astro:prefetch` needed).
- `output: "server"`, `adapter: cloudflare({...})`, `integrations: [react()]` — unchanged.
- Verify `inlineStylesheets: "auto"` keeps critical CSS inline post-CSS-migration.

## 14. Risks & mitigations

| Risk                                                                                                       | Mitigation                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| HTML-iframe pages flicker on every nav (cannot be avoided per view-transitions docs, applies to shell too) | Detect `source_type == "html"` in shell; reuse iframe element by swapping `srcdoc` rather than recreating it         |
| Service binding adds latency to edge-originated `/api/*` calls                                             | Direct DNS for MCP (agents) bypasses edge entirely; browser `/api/*` traffic is small per nav                        |
| Smart Placement may return `UNSUPPORTED_APPLICATION` if traffic too low                                    | Auto-disable script in CI cron: poll `placement_status`, revert if undesirable                                       |
| D1 paid plan & replica costs                                                                               | Budget alert on Cloudflare account; tier downgrade reversible                                                        |
| Removing ClientRouter breaks any current consumer that depended on `astro:page-load` outside `/p/*` `/f/*` | Repo grep before deploy; on full-page routes the lifecycle event is replaced by `DOMContentLoaded`                   |
| Module-level state removal could miss a call site                                                          | TypeScript catches: rename the exported maps so any leftover read throws at compile time                             |
| Test suite slowness from Playwright                                                                        | Mark `mcp-perf.spec.ts` and mobile suite as `@slow`; run nightly only                                                |
| One-shot legacy migration fails mid-deploy                                                                 | Pre-run the migration in staging; keep `wrangler d1 time-travel restore` ready for rollback                          |
| Server-island encryption key rotation breaks in-flight requests                                            | `ASTRO_KEY` set permanently via secret; never rotated during a deploy window                                         |
| CLI Rust client drifts from REST                                                                           | Codegen the Rust types from TS via `ts-rs` or hand-port the small surface; lock with a test that hits every endpoint |

## 15. Sequencing (within v1, parallel tracks per decision #2)

Per the user direction "hours not days", these tracks run in parallel and converge into one PR (or a coordinated stack of PRs):

| Track                           | Files                                                        | Estimated effort |
| ------------------------------- | ------------------------------------------------------------ | ---------------- |
| A — Backend repo + lock removal | `runtime.ts` split, `middleware.ts`, every persist call site | Largest          |
| B — Worker split                | New `wrangler.backend.jsonc`, build pipeline, dev shim       | Medium           |
| C — Payload + shell             | `document-payload.ts`, `shell/*.ts`, `AppLayout.astro`       | Medium           |
| D — Server islands              | 3 new `.astro` components + integration                      | Small            |
| E — Lazy hydration              | Directive flips + tests                                      | Small            |
| F — `packages/services`         | New package + adapter rewrites                               | Medium           |
| G — Public route caching        | Cache-Control + content-hash                                 | Small            |
| H — Playwright + Vitest         | New `tests/e2e/` suites                                      | Medium           |
| I — D1 replicas + Sessions      | Wrangler bindings + handler wrapper                          | Small            |
| J — Astro/CSS migration         | Layout imports + ClientRouter removal                        | Small            |

Convergence checklist before deploy:

1. `pnpm typecheck && pnpm test && pnpm --filter @vegastack/pages-web build`
2. `wrangler check startup` on both wrangler configs
3. Playwright suite green
4. Staging deploy: backend → edge → smoke test → verify `placement_status: SUCCESS` at 15 min
5. Production deploy: same order, with `wrangler d1 time-travel info` snapshot ID captured for rollback
6. Post-deploy: 24 h monitoring of p50/p95 mutation latency (target: writes < 100 ms p95) and `placement_status`

## 15.5. Self-host installer parity

The existing `install/cloudflare/bootstrap.mjs` and `install/cloudflare/wrangler.example.jsonc` must produce **two** Wrangler configs after this change (`wrangler.frontend.jsonc` + `wrangler.backend.jsonc`). Update `install/cloudflare/bootstrap.mjs` to:

- Generate both files from a shared template.
- Provision the secondary D1 binding `DB_REPLICA` with `experimental_remote: true`.
- Create the service binding from edge → backend.
- Prompt for replica regions (default: NA + EU).
- Print the two `wrangler deploy` invocations in order (backend first).

For Node self-hosters, the installer flow is unchanged: `pnpm install`, set env vars, `pnpm build`, run with `@astrojs/node`. No two-process complexity; the same backend code runs in the same Astro process. Document this in `install/node/README.md` if it doesn't already exist.

## 16. Out of scope for v1 (explicit)

- Multi-user live collaboration via Durable Objects — deferred; current snapshot model not durable enough, but DOs are a v2 feature not a perf fix.
- Public publication shell — explicit decision (Round 4, #15).
- Public-anonymous user prefetching from sidebar to other public pages — separate work.
- Hyperdrive — no external Postgres/MySQL, not applicable.
- Workers AI integration — separate roadmap item.

## 16.5. Implementation progress log (this branch)

Branch `feat/instant-workspace-v1` off `main` (no `develop` exists yet). All work checkpointed below is type-checked, tested, and built clean.

### Delivered (this work-in-progress)

**Foundation**

- `.dev.vars` (gitignored): `ASTRO_KEY` + `VPG_INTERNAL_KEY` generated, queued for `wrangler secret put` at deploy time.
- `apps/web/src/lib/runtime/target.ts` — runtime detection (`cloudflare-edge` / `cloudflare-api` / `node`).
- `apps/web/src/lib/api-client.ts` — service-binding-or-in-process dispatcher.
- `apps/web/src/backend/index.ts` — backend Worker entry stub.
- `install/cloudflare/wrangler.frontend.example.jsonc` + `wrangler.backend.example.jsonc` — split-Worker templates with Smart Placement on backend, ASSETS+KV on edge, D1 primary+replica binding on backend, service binding edge→backend.

**packages/services (Workstream F)**

- `ServiceContext`, `Actor`, `MutationEnvelope`, `ServiceError`, `SessionHandle` types.
- `buildEnvelope`, `attachEnvelope`, `jsonWithEnvelope` helpers + 9 Vitest cases.
- Repo interfaces (async): `FavoriteRepo`, `PageRepo`, `CommentRepo`, `WorkspaceRepo`.
- In-memory repo adapters in `apps/web/src/lib/runtime/repos/` (wrap existing services).
- `repos` registry exported from `apps/web/src/lib/runtime/repos/index.ts`.
- Application services: `favorites`, `pages`, `comments`.
- 6 Vitest cases for `favorites.service`.

**Document payload + endpoints (Workstream C, partial)**

- `apps/web/src/lib/document-payload.ts` — `buildPageDocumentPayload()` + `buildFolderDocumentPayload()` + `DocumentPayload` type.
- `GET /api/workspaces/:wid/documents/page/:ref` — partial endpoint (member or public-publication access).
- `GET /api/workspaces/:wid/documents/folder/:ref` — partial endpoint.
- 6 Vitest cases for the builder + 6 for the partial routes (verifying status codes, payload shape, ref-by-id-or-slug, workspace-mismatch 404s).

**Shell controller (Workstream C, partial — built but not yet wired)**

- `apps/web/src/scripts/shell/index.ts` + `types.ts` — `bootShell()`, link interception (capture phase), history.pushState management, DOM swap, `astro:page-load` dispatch, full-page fallback, D1 bookmark replay via `x-vpg-d1-bookmark`.

**Mutation envelope (Workstream G — COMPLETE)**

- 27 nav-affecting routes return `{ envelope: { tree_version, content_hash, navigation_invalidated, changed_resources[] } }`.
- Auth/setup/render routes intentionally excluded.

**Lazy hydration (Workstream E, partial)**

- `CommandPalette` and `CommentsRail` flipped from `client:load` → `client:idle` in `/p/:slugId` and `/f/:slugId`.
- CSS migration deferred until shell wire-in (needs `WorkspaceLayout` extraction so we don't load `docs.css` on auth/landing pages).

**Public publication caching (Workstream J — COMPLETE)**

- Public + indexable publications: `Cache-Control: public, max-age=300, s-maxage=31536000, stale-while-revalidate=60`.
- Password-gated: `Cache-Control: private, max-age=60` + `Vary: Cookie`.
- Authenticated workspace: `Cache-Control: private, no-store`.
- `ETag` combines `content_hash` + `publication.updatedAt` + password state.
- `If-None-Match` short-circuit returns 304.

**Route migration to service+repo (Workstream A, in progress)**

16 nav-affecting routes now go through `@vegastack/pages-services` + `repos.*`:

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
| `/api/workspaces/[workspaceId]/pages.ts` POST       | `services.pages.create`                    |
| `/api/workspaces/[workspaceId]/folders.ts` POST     | `services.workspaces.createFolder`         |
| `/api/folders/[folderId]/reorder.ts` POST           | `services.workspaces.reorderFolder`        |

Every migration uses `buildServiceContext({ cookies, request, workspaceId })` from `apps/web/src/lib/service-context.ts`, so adding more is a 5-minute mechanical change. Routes still pending include the publications/templates/members/access/settings/github-backup surfaces — each has cross-cutting orchestration (email sends, MCP session revocation, audit fanout) that doesn't cleanly belong inside the service layer.

### NOT delivered (each needs a dedicated focused session)

- **Workstream A real implementation**: `runtime.ts:2347-2410` (`persistNormalizedRuntimeStateBatch`) still runs. The global mutation lock in `middleware.ts:158-178` still holds. Direct-D1 adapters per resource not yet written. Removing the lock requires every nav-affecting route to write directly to D1 (write-through) — partial migration creates data races.
- **Shell wire-in**: needs `buildPageDocumentPayload` to emit a richer HTML chunk (title + description + metadata + prose) so the shell can swap the full article innerHTML, OR a separate refactor of the `[slugId].astro` template to call `buildPageDocumentPayload()` as the single source. Either way, needs in-browser testing (cannot validate without `pnpm dev` + real Chrome to check PageHeader/Sidebar lifecycle).
- **ClientRouter removal**: deferred until shell wire-in proves stable.
- **Server Islands (D)**: components designed but not created in code yet. Wiring them needs `PageHeader.astro` refactor to render via deferred-island slots instead of inline `commentsBadge` / favorite button.
- **Playwright (H)**: not added. Best done after shell wire-in lands so the suite can verify "no full reload on /p ↔ /p nav" end-to-end.
- **D1 Sessions + replicas (I)**: paid D1 plan + replication enablement is a one-way account operation; queued for explicit deploy approval.
- **CSS migration (E)**: deferred. Needs `WorkspaceLayout.astro` sub-layout so `docs.css` / `comments.css` only load for workspace routes, not auth/landing.
- **Installer updates (K)**: `install/cloudflare/bootstrap.mjs` still generates a single-Worker config; needs update to emit two configs once the split deploys.

### Test deltas

Baseline `main`: 289 tests passing. Branch state: **333 tests passing** (+44 new):

- 9 envelope helper tests
- 6 document payload builder tests
- 6 favorites.service tests
- 7 pages.service tests
- 5 comments.service tests
- 5 workspaces.service tests
- 6 document-route partial endpoint tests

## 17. Doc citations referenced in this plan

Astro (`/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/`):

- `guides/view-transitions.mdx:39` — Astro's own ClientRouter deprecation hint
- `guides/view-transitions.mdx:74-160` — `transition:persist` semantics & caveats
- `guides/view-transitions.mdx:498-528` — Client-side navigation process
- `guides/view-transitions.mdx:540` — Bundled scripts execute once
- `basics/astro-pages.mdx:135-200` — Page Partials (and why not to use them here)
- `guides/server-islands.mdx` — `server:defer`, encryption key, fallback content
- `guides/prefetch.mdx:38-44, 92-107` — Strategies + programmatic prefetch
- `guides/integrations-guide/cloudflare.mdx:340-358` — KV Sessions, eventual consistency
- `guides/integrations-guide/cloudflare.mdx:389-410` — `nodejs_compat`

Cloudflare (`~/.claude/plugins/marketplaces/cloudflare/skills/`):

- `workers-best-practices/SKILL.md:46, 53-57, 74` — Secrets, `waitUntil`, no global state
- `workers-best-practices/references/rules.md:144-167, 218-238` — `waitUntil`, service bindings
- `cloudflare/references/smart-placement/README.md` — When to enable
- `cloudflare/references/smart-placement/gotchas.md` — Pages/Assets degradation, monolithic anti-pattern
- `cloudflare/references/d1/README.md:62-82` — Sessions, read replicas, limits
- `cloudflare/references/d1/patterns.md:130-180` — Replica + bookmark patterns
- `cloudflare/references/workers/gotchas.md:38-44` — D1 read-after-write via Sessions API
