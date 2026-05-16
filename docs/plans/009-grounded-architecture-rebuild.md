# 009 — Grounded Architecture Rebuild

Status: Draft for review. Supersedes plan 008.
Owner: K Manoj Kumar.
Date: 2026-05-16.

## 0. What this plan is, and why

Plan 007 shipped the foundation (services package, mutation envelope, document-payload API, shell controller scaffolding, in-memory repo registry) and was cleared through four audit cycles. Plan 008 was a perf-gap audit that identified the real compute costs not yet addressed. This plan is the **grounded successor** to 008 — every recommendation here is cross-checked against:

- The Cloudflare skills under `.agents/skills/{cloudflare,workers-best-practices,web-perf,durable-objects,wrangler,sandbox-sdk,agents-sdk}/`.
- The Astro 6 documentation at `/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/`.
- The **current state of our Cloudflare deployment** (D1 + KV provisioned, no Workers deployed yet, R2 bucket not yet created, Wrangler v3.109.2 — outdated, current is v4.92.0).
- Patterns from popular OSS MCP servers (modelcontextprotocol/servers, Linear, Notion, Sentry MCPs), agent CLIs (gh, wrangler, vercel, supabase, fly, neon, planetscale), and Anthropic's 2025–2026 engineering writeups on tool design and effective agent harnesses.

The goal is **not** to add functionality. The goal is to land the Mintlify-class instant-load promise (cold-edge → static-immutable bytes), tighten the agent-facing surfaces (MCP + CLI) to current best practice, and remove the perf killers the prior plans left in place (the global mutation lock and runtime-state hydration on every request).

Where I need your input, decisions are marked **DECISION:** with my recommendation.

---

## 1. Corrections to plan 008 after grounding

| 008 reference                                   | Status after grounding                           | Note                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.3 folder cache parity                        | **Already done in cycle 4.**                     | `f/[slugId].astro:98-132` has the full ETag + 304 block (verified).                                                                                                                                                                                                                                            |
| §2.2 publish-time SEO HTML                      | **Drop.**                                        | No consumer; adds a second R2 PUT per write with no current beneficiary.                                                                                                                                                                                                                                       |
| §6.5 prefetch tuning                            | **Defer until measurement.**                     | The shell isn't even active; optimizing prefetch around it is premature.                                                                                                                                                                                                                                       |
| §5 service-binding split (and 007 worker split) | **Must be fetch-based, not RPC.**                | Smart Placement only works with fetch-based service bindings — `placement` is a no-op for RPC class-method bindings. Source: `.agents/skills/cloudflare/references/smart-placement/patterns.md` lines 52–74.                                                                                                   |
| 007 Workstream C shell controller               | **Drop in favor of Astro's `<ClientRouter />`.** | Astro 6's `view-transitions.mdx` lines 49–62 + 740–775 describe what we hand-rolled. The skill explicitly notes ClientRouter is now the standard. Our cycle-4 shell helpers stay as infra, but `AppLayout.astro` mounts `<ClientRouter />`, not `bootShell()`. F-017 (folder payload SSR parity) becomes moot. |
| 007 KV use for nav cache                        | **Keep KV for sessions only.**                   | KV's eventual-consistency caveat (`.agents/skills/cloudflare/references/kv/gotchas.md` lines 6–19) is too constraining for nav. Per-request memoization + D1 reads with read replicas is the right shape.                                                                                                      |
| 008 §2.1 pre-render artifact                    | **Keep, with corrections.**                      | Must include `RENDERER_VERSION` in the artifact key, must use a strict write order, and must consider Cloudflare Workers Cache API as the primary edge layer (not the only layer). See §4.                                                                                                                     |

The five HIGH and most MEDIUM cycle-3 findings remain resolved as of cycle 4 (see `docs/audit-report-002.md`).

---

## 2. Current state of our deployment (ground truth)

This is what we have, not what we want:

- **Wrangler CLI version: v3.109.2** in the working tree; current is **v4.92.0**. The skill (`.agents/skills/wrangler/SKILL.md`) describes v4 behaviors we are not on. We must upgrade before any deploy.
- **Account D1**: `vegastack_pages_prod` (UUID `e85aea0b-8068-430a-a2b6-53a74dc591e6`), created 2026-05-11. **Zero tables.** Migrations have never run.
- **Account KV**: `vegastack-pages-sessions-prod` (id `f651e62192514a498d94b3f0277e0091`). Provisioned, empty.
- **Account R2**: **No bucket named `vegastack-pages-content` exists.** Plan 007 + 008 both assume this bucket — it has not been created yet.
- **Workers deployed**: zero. The single-Worker `wrangler.example.jsonc` and the three-Worker split (`wrangler.frontend.example.jsonc`, `wrangler.backend.example.jsonc`) are templates; nothing has been pushed to production.
- **compatibility_date**: `"2026-05-10"` (set on all three templates).
- **compatibility_flags**: `["nodejs_compat", "global_fetch_strictly_public"]` (set on all three templates).
- **Smart Placement**: configured on the backend template (`wrangler.backend.example.jsonc:31-33`).
- **D1 read_replication**: configured as `experimental_remote: true` on the `DB_REPLICA` binding (`wrangler.backend.example.jsonc:73-78`) — requires paid D1 tier.
- **Observability**: configured with `head_sampling_rate = 1` on both templates.
- **Custom domain**: not configured in any wrangler template (no `routes` block, no `zone_id`).
- **Secrets to set before first deploy**: `ASTRO_KEY`, `VPG_INTERNAL_KEY`, `VPG_GITHUB_APP_PRIVATE_KEY` (if Backup-to-Git enabled), `VPG_MCP_TOKEN` (if static MCP token used), email-provider secrets.

**Implication for this plan**: we have a clean slate. There is no production deployment to migrate; we just need to land the right shape on the first deploy. This is a strong constraint in our favor.

---

## 3. Target architecture (grounded)

### 3.1 Worker topology

Two Workers, in this order of priority:

1. **Edge Worker** (`vegastack-pages-edge`)
   - Routes: `pages.vegastack.com/*` (managed) + custom domains for self-host.
   - Bindings: `ASSETS` (static `dist/client`), `SESSIONS` (KV), `API` (service binding → backend, **fetch-based**), `CONTENT_PUBLIC` (R2 binding for public publication artifacts).
   - Job: serve `dist/client` static assets, terminate public publication GETs (cache + R2), forward `/api/*` and `/mcp` to backend.
2. **Backend Worker** (`vegastack-pages-api`)
   - Routes: none directly; only reachable via the edge service binding.
   - Bindings: `DB` (primary D1), `DB_REPLICA` (read-replicated D1, paid tier), `CONTENT` (R2 source + renders), `EMAIL` (send_email), `SESSIONS` (KV), `placement: { mode: "smart" }`.
   - Job: every authenticated read/write, D1 mutations, MCP tool calls, rendering.

**Why two Workers, not three:** the cloudflare skill flags two principles that converge: (a) Smart Placement reduces D1 latency only when the placed Worker holds the DB binding — moving the MCP into a separate Worker just to isolate it adds a service-binding hop without latency benefit (`smart-placement/patterns.md` lines 25–52); (b) Workers have a 1 MB compressed bundle limit, but Astro+services together fit comfortably below that, so there's no bundle reason to split MCP out. MCP lives on the backend.

**DECISION needed:** Confirm two-Worker over three-Worker. My recommendation: two.

### 3.2 D1 + R2 + KV + Cache layout

- **D1 primary**: all writes go here. Sessions API (`env.DB.withSession()`) is used wherever a route does a write-then-read in the same request so read replicas stay strongly consistent. Cite: `.agents/skills/cloudflare/references/d1/patterns.md` lines 119–179.
- **D1 read replicas**: read-only handlers (search, public publication listing, the `/api/workspaces/:wid/tree` payload, MCP `vpg_list_*` calls) target `DB_REPLICA`. Honor the "replication lag is 100ms–2s; use primary for read-after-write" rule (`d1/gotchas.md` lines 70–73).
- **R2 buckets**:
  - One bucket `vegastack-pages-content` with prefixes:
    - `pages/{wsId}/{pageId}/current.{md|mdx|html}` — source (always overwritten).
    - `pages/{wsId}/{pageId}/versions/{versionId}.{md|mdx|html}` — versioned source (immutable).
    - `pages/{wsId}/{pageId}/renders/{contentHash}.{RENDERER_VERSION}.json` — pre-rendered HTML + headings + frontmatter (immutable, see §4).
    - `attachments/{wsId}/{pageId}/{attachmentId}` — attachments.
  - The bucket is **NOT** made publicly browsable. Public publications are served _through_ the edge Worker so we can layer auth/password/ETag/Cache-Control. We accept the loss of "fully serverless R2 public bucket" in exchange for keeping a single auth contract.
  - Public read responses use `Cache-Control: public, max-age=300, s-maxage=31536000, stale-while-revalidate=60` for indexable, short shared for link-only, private for password-gated (cycle-4 work, confirmed).
- **KV** (`SESSIONS` namespace):
  - Auth sessions, magic-link tokens (TTL-bound).
  - **Not used for navigation cache** — KV's eventual consistency means a sidebar might lag behind a page rename by up to 60s. Use the D1 + per-request memoization path instead.
- **Workers Cache API** (`caches.default`):
  - Public publication HTML — keyed by `URL + content_hash`. On miss, render to artifact path (§4) and `ctx.waitUntil(cache.put(...))` so the next colo visitor is free.
  - Skill citations: `.agents/skills/cloudflare/references/workers/api.md` lines 55–67, `workers/patterns.md` lines 74–82.

### 3.3 Compatibility flags + observability + cron

Final wrangler shape (excerpt) for the backend Worker:

```jsonc
{
  "compatibility_date": "2026-05-10",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "placement": { "mode": "smart" },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "vegastack_pages_prod",
      "database_id": "...",
    },
    {
      "binding": "DB_REPLICA",
      "database_name": "vegastack_pages_prod",
      "database_id": "...",
      "experimental_remote": true,
    },
  ],
  "r2_buckets": [
    { "binding": "CONTENT", "bucket_name": "vegastack-pages-content" },
  ],
  "kv_namespaces": [{ "binding": "SESSIONS", "id": "..." }],
  "triggers": { "crons": ["17 2 * * *"] },
  "vars": { "VPG_RUNTIME": "cloudflare-api" },
}
```

`VPG_RUNTIME` is the explicit discriminator from cycle-4 F-013 work; with it set, the binding-shape inference in `apps/web/src/lib/runtime/target.ts` becomes belt-and-braces, not the primary path.

---

## 4. The pre-rendered HTML artifact (the load-bearing change)

This is the single biggest performance lever. Plan 008 §2.1 had it right; here is the grounded form.

### 4.1 Write path

In the backend Worker, the only place that mutates page source is `PageService.updateSource` (and `createPage`, which also writes initial source). Both go through a single function. The write order MUST be:

1. **Atomically** in D1: bump `version_id`, set `content_hash`, write `frontmatter_json` (extracted from the unified pipeline — Finding F from 008), write `render_cache_key = "{contentHash}.{RENDERER_VERSION}"`. Use a `BEGIN/COMMIT` transaction; D1 supports this via `env.DB.batch()` for the single-statement-list case, or `env.DB.exec()` for a multi-statement string. Cite: `.agents/skills/cloudflare/references/d1/patterns.md` lines 84–105.
2. **R2 PUT** the new source object (versioned + current overwrite).
3. **Compute** `renderMarkdown(source)`. This produces `{ html, headings, frontmatter }`.
4. **R2 PUT** the artifact at `pages/{wsId}/{pageId}/renders/{contentHash}.{RENDERER_VERSION}.json`. Body is JSON; `Content-Type: application/json`; immutable.

If step 4 fails, log the failure (Workers Logs + Tail), do NOT roll back the D1 write — the read path (§4.2) falls back to live render. The artifact is a cache, not a source of truth. This makes the contract: "the artifact may be missing, but it must never be wrong."

`RENDERER_VERSION` is baked at build time. It is the SHA-256 of:

- `packages/renderer/package.json` version field,
- the names + versions of all unified plugins in the chain (`packages/renderer/src/index.ts:426`),
- the Shiki theme set + preloaded language list.

Compute it during `pnpm build` via a small script; expose it via `astro:env` (Astro 6's recommended pattern — `guides/sessions.mdx` lines 82–89 show the analog).

**DECISION needed:** Should `RENDERER_VERSION` be a build-time constant or a runtime env var that operators can bump to invalidate everyone's cache? My recommendation: build-time constant, computed deterministically. Operators get fresh artifacts on every deploy.

### 4.2 Read path

For a `/p/[slugId]` GET, in order:

1. D1 lookup for the page row (existing).
2. `permission` resolution (existing).
3. **NEW**: If `page.renderCacheKey === "{contentHash}.{RENDERER_VERSION}"` (the canonical key), GET `pages/.../renders/{contentHash}.{RENDERER_VERSION}.json` from R2 via the binding. Same Worker network → free egress (`workers-best-practices/SKILL.md` line 61). Typical R2 GET on same region: 5–15 ms vs. 150–500 ms for a live Shiki render.
4. **On R2 miss or wrong renderer version**: live render through `renderCachedMarkdown` (existing per-isolate LRU) as a fallback. Fire-and-forget `ctx.waitUntil(...)` to repair the artifact for the next visitor.
5. SSR composes the document.

Combined with the Workers Cache API layer for public publications (§3.2), the latency story becomes:

| Visitor scenario                                 | Today                                              | After 009                                                  |
| ------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------- |
| First in cold colo, public publication           | 150–500 ms Shiki render + 50 ms D1 + 20 ms compose | 5–15 ms R2 GET + 50 ms D1 + 20 ms compose. **~10× faster** |
| Second in same colo, public publication          | Same as first (per-isolate LRU only)               | Edge cache hit. **~5 ms total**                            |
| Authenticated workspace view (never edge-cached) | Same as first                                      | Same as first, but with R2 artifact GET instead of render  |
| Same isolate, after warming                      | LRU hit (~5 ms)                                    | LRU hit (~5 ms) — unchanged                                |

The **first-visitor-in-cold-colo** number is the Mintlify-class delta.

### 4.3 Self-host (Node) path

On Node, `updateSource` runs the renderer inline (same code). The artifact is written to the filesystem object store at the equivalent path. The 100–300 ms write-time latency is paid by the agent that wrote the page; reads are free. Cycle-3 F-003 already noted this is acceptable.

### 4.4 Backfill

Existing pages do not have artifacts. On deploy of the artifact-write code, run a **resumable Worker cron** that walks D1 pages oldest-first, paginates with a `LAST_PROCESSED_ID` KV bookmark (sessions namespace, dedicated key), and renders+writes artifacts at 20 pages/minute (well under D1 / R2 rate limits). The cron stops when D1 reports `next_id` is null.

---

## 5. Astro 6 modernization (where we are reinventing)

### 5.1 Drop the custom shell, adopt `<ClientRouter />`

Astro 6's `guides/view-transitions.mdx` lines 49–62 + 740–775 describe the exact behavior we built in `apps/web/src/scripts/shell/index.ts`:

- Intercept same-origin link clicks.
- Fetch the next page.
- Update the DOM, history, focus, and announce the route.
- Dispatch `astro:page-load` so existing initializers re-bind.

`<ClientRouter />` also handles popstate, prefetch coordination, and skips for `download` / `target=_blank` / modifier-clicks — all things we re-implemented. The fallback semantics (full nav on error) are baked in.

We get all of this for free by adding `<ClientRouter />` to `AppLayout.astro`. Our cycle-4 shell tests (`scripts/shell/__tests__/index.test.ts`) and helpers stay, but the controller stops being mounted. F-017 (folder payload SSR parity) becomes moot because there's no payload — ClientRouter SSRs the next page on demand and Astro view transitions handle the visual.

**DECISION needed:** Confirm adopting `<ClientRouter />` and removing `bootShell()` from `AppLayout.astro` (it was never wired anyway). My recommendation: yes. Net code removed > code added.

### 5.2 Hybrid prerender for indexable public publications

`guides/on-demand-rendering.mdx` lines 100–124 + `reference/configuration-reference.mdx` show how to set `export const prerender = true|false` per route. For us:

- `/p/[slugId]` and `/f/[slugId]` stay on-demand (`prerender = false`) because publications can be revoked, password-gated, or made private at any moment.
- `/docs/*` stays prerendered (already is).
- **NEW**: For a small set of well-known indexable public publications (the marketing pages, the canonical examples), consider a build-time `getStaticPaths()` that emits them as static HTML at the edge. This is only worth it if we have a stable allow-list of pages — for the general case, the §4 R2 artifact is better because it auto-updates.

**DECISION needed:** Defer build-time `getStaticPaths()` until we have a stable allow-list. Confirm? My recommendation: yes, defer.

### 5.3 Server Islands for personalization layers

`guides/server-islands.mdx` lines 7–9 + 17 + 108 are exactly the pattern for our comments-stats, favorites, and permission badges:

- The page body (which can be pre-rendered or edge-cached) renders instantly.
- Each personalization island streams in via `server:defer` from a tiny endpoint.

Plan 007 wrote islands but cycle 4 left them deferred. The actual lift here is small: convert the existing `CommentsRail` / favorite badge / permission display to use the island pattern with a `server:defer` directive and a lightweight fallback. Each island gets its own endpoint that hits `DB_REPLICA` only. The shell renders without waiting for them.

### 5.4 Astro Actions for write API routes

`guides/actions.mdx` lines 13–32 + 208–232 describe a typed RPC layer (Zod-validated, single error shape, callable from forms, components, or scripts). Our 30+ hand-rolled API mutation routes (`apps/web/src/pages/api/**/*.ts`) reimplement this with hand-rolled validation and ad-hoc error shapes.

Migration path:

1. Define an `actions/index.ts` that mirrors the public API surface (e.g., `actions.pages.create`, `actions.pages.updateSource`, `actions.comments.reply`, …).
2. The action handlers do exactly what the API routes do today — assemble the `ServiceContext`, call the service, return the envelope.
3. The API routes stay (for external callers like MCP and CLI), but become thin wrappers around the actions.
4. The Astro client (forms, scripts) calls actions directly via type-safe imports.

This is a Phase D lift, not blocking anything. The MCP + CLI surfaces continue to speak HTTP+JSON-RPC.

**DECISION needed:** Confirm Astro Actions adoption for browser-side mutations. Recommendation: yes, Phase D.

### 5.5 Content collections — defer

`guides/content-collections.mdx` describes content collections. Our `/docs/*` could be a content collection. The migration is mechanical but the win is small (we already have type-safe frontmatter via the renderer). Defer to a later cleanup.

---

## 6. Remove the actual perf killers (workstream A unlock)

Plan 008's F-024 and F-025 noted that the global mutation lock (`acquireRuntimeMutationLock`) and whole-runtime hydration (`persistRuntimeState`) remain on every mutation. These are the real bottleneck — far more than the renderer is.

The cycle-4 work didn't touch these because the in-memory adapter is still the only repo implementation. The cure is the D1-direct repo adapter — write directly to D1 in each repo method, never hydrate the whole state. Plan 007 framed this as workstream A; this plan formally schedules it.

Sequence:

1. Each `apps/web/src/lib/runtime/repos/*.in-memory.ts` gets a sibling `*.d1.ts`.
2. The repo registry (`apps/web/src/lib/runtime/repos/index.ts`) picks based on `target.ts` runtime detection.
3. With D1-direct: drop the lock in `apps/web/src/middleware.ts:158-177`, drop the `persistRuntimeState` call after writes.

Once D1-direct lands, the renderer is the only meaningful per-request CPU cost, and §4 addresses that.

This is structurally separable from §4 (you can ship the artifact write first), but they compose: D1-direct reads + R2 artifact read = a workspace `/p/[slugId]` GET that does 2–3 D1 calls + 1 R2 GET, no global hydration, no lock.

---

## 7. MCP rebuild (against 2026 best practice)

Audited against the MCP spec (2025-06-18 revision) and Anthropic's "Writing tools for agents" + "Code execution with MCP" engineering posts.

### 7.1 Annotations on every tool

Per the spec, every tool SHOULD declare `readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`, and `title`. Today: zero of our 34 tools have any of these. The annotations are what lets MCP hosts (Claude Code, Cursor, Continue) decide whether to confirm with the user before invoking — without them, every tool is treated as potentially destructive.

Assignment for our 34 tools:

- `readOnlyHint: true`: `get_page`, `list_*`, `search_*`, `whoami`, `list_workspaces`, `validate_page_source`, `wait_for_review`, `list_page_versions`, `list_comments`, `list_review_events`, `list_templates`, `get_template`, `render_template` (pure compute), `list_workspace`.
- `idempotentHint: true`: `update_page` (writing the same source twice is a no-op via content_hash), `move_page`, `update_thread`, `update_template`, `publication_apply` (upsert by publication key), `restore_page_version`.
- `destructiveHint: true`: `delete_thread`, `publication_delete`, `restore_page_version` (overwrites current), `move_page` (changes URL).
- `idempotentHint: false, destructiveHint: false`: `create_page`, `create_comment`, `create_page_snapshot`, `upload_attachment`, `create_template`, `create_page_from_template`, `invite_workspace_member`, `prepare_page_edit`, `patch_page` (because each call advances `base_version_id`).
- `openWorldHint: true` where the tool reaches external systems (`upload_attachment` writes to R2; arguably this is in our world; leave false).

### 7.2 `outputSchema` on every tool

Per the spec, when a tool returns structured data, it SHOULD declare `outputSchema` so clients can validate. Our `@vegastack/pages-services` types already give us the schemas — we can derive Zod or JSON Schema from them and ship them in the tool descriptor.

### 7.3 Namespace prefix

Anthropic's 2026 "Writing tools for agents" post measures eval deltas from namespacing. In a multi-MCP host (which is increasingly common), our tools collide with everyone else's `get_page`. Adopt `vpg_` prefix on all tool names: `vpg_get_page`, `vpg_create_page`, etc.

**DECISION needed:** Aliased rollout or breaking rename? My recommendation: ship both names for one minor release (`vpg_get_page` is canonical, `get_page` redirects with a deprecation notice in the tool description), then drop the unprefixed names in the next release.

### 7.4 Composition tools

008 §5.2 was right. The two adds:

- **`vpg_prepare_page_edit_v2`** (new name to keep the old one stable): returns `{ page, source, base_version_id, base_content_hash, open_comment_threads: [{thread_id, anchor, last_reply_at}], latest_versions: [{version_id, created_at, author}] }` in one call. Internally calls existing services in parallel via `Promise.all`. Replaces the 3-call (`get_page` + `list_comments` + `list_page_versions`) pattern agents currently run.
- **`vpg_list_comments_since`**: incremental fetch. Takes `since: ISO timestamp` and `cursor?`, returns threads/replies updated after `since`, plus a `next_cursor`. Agents in a `wait_for_review` loop currently re-fetch all threads on every poll; this collapses it to deltas.

Plus a third add that came out of grounding: **`vpg_get_page` with `include: ("comments" | "versions" | "permissions" | "renders")[]`**. This lets a curious agent inspect one page deeply in a single call without the agent needing to discover that `prepare_page_edit_v2` exists. Linear's MCP does this exact pattern.

### 7.5 Pagination and truncation

Today `list_pages` returns the full workspace tree in one response. For a 10k-page workspace, that's a 5 MB JSON response, well past Claude Code's 25k-token tool-response cap.

Add `cursor: string?` + `limit: number?` (default 200, max 1000) to every list-style tool. Return `next_cursor: string | null` in the result. Spec citation: MCP spec 2025-06-18 §tools.

Add a `response_format: "DETAILED" | "CONCISE"` enum on `vpg_get_page`. The concise form drops `source` and `versions` from the payload (use `vpg_prepare_page_edit_v2` if you need them).

### 7.6 Error semantics

Today, business errors flow through `isServiceError(error)` → `Response.json({ error: { code, message } }, { status })`. For MCP, this returns a JSON-RPC error response. Per the spec, business failures (404, permission denied, validation failure) SHOULD be `isError: true` on the tool result with a human-readable message — JSON-RPC errors are for protocol issues only (unknown tool, bad args).

Refactor MCP handler in `apps/web/src/pages/mcp.ts` to:

- Wrap service calls in try/catch.
- On `ServiceError`, return `{ content: [{ type: "text", text: <agent-actionable message> }], isError: true }`.
- On thrown protocol errors (unknown tool), return a JSON-RPC error.

The agent-actionable messages matter: instead of `"PAGE_NOT_FOUND"`, return `"Page pg_123 was not found. Use vpg_search_workspace with a query to find it, or vpg_list_pages to enumerate visible pages."`. Anthropic's engineering post argues this is the single biggest lever on agent loop efficiency.

### 7.7 Resources

We have a `resources/list` + `resources/read` surface but it's under-documented and agents don't use it. Document in `skills/vegastack-pages` that `vpg://pages/{id}` reads are cheaper than `vpg_get_page` calls when you only need source. Add resource templates for `vpg://pages/{id}/comments` (current open threads) and `vpg://pages/{id}/versions` (recent versions).

---

## 8. CLI rebuild (against 2026 best practice)

Audited against `gh`, `wrangler`, `vercel`, `supabase`, `fly`, `neon`, `planetscale` CLIs.

### 8.1 The four high-leverage changes

1. **Shared HTTP client.** Replace the three `reqwest::blocking::Client::builder()` sites in `cli/vegastack-pages/src/main.rs` with a single lazy `OnceCell<Client>` at module scope. Enable `gzip` feature: `reqwest = { features = ["json", "gzip", "rustls-tls"] }`. Real keep-alive, real TLS session resumption, real compression. Estimated win: 100–300 ms per command after the first.
2. **`--json` / `--format` flags.** No subcommand emits structured output today. Add `--format=text|json|tsv` with `--json=<fields>` field selection (mirror `gh`'s `--json title,number`). Auto-detect TTY: piped output drops color and truncation. Estimated effort: medium (touches every subcommand's output path) but the user-visible lift makes the CLI scriptable.
3. **Noun-verb taxonomy everywhere.** The CLI today mixes `Login`/`Whoami`/`Publish` (verb-first) with `Pages get` / `Templates list` (noun-verb). Standardize on noun-verb: `vpg auth login`, `vpg auth whoami`, `vpg pages publish`, `vpg pages get`, `vpg publications revoke`, `vpg comments reply`, `vpg comments resolve`. The aliases stay for one release.
4. **Shell completions + auto-updater.** Add `vpg completion {bash|zsh|fish|powershell}` via `clap_complete`. Add `vpg upgrade` (or wire `vpg self-update`) to fetch a new binary from npm.

### 8.2 Lower-priority but worth doing

- **Project file**: `.vegastack-pages.yaml` at repo root holds default workspace + folder, so `vpg pages list` works without flags. Mirror the `wrangler.jsonc` / `fly.toml` pattern.
- **Parallel bulk ops**: `vpg pages import` and `vpg attachments upload` use `tokio::spawn` + `futures::stream::buffer_unordered(8)`. Default serial; opt in via `--parallel=N`.
- **Conditional GETs**: after the JSON ETag work (§4), the CLI sends `If-None-Match` on `vpg pages pull` polls. A no-op pull becomes ~1 KB.
- **Telemetry (opt-out)**: anonymized command-name counts to a `cli.events.vegastack.com` endpoint. Strictly opt-out, documented. Helps prioritize improvements.

### 8.3 MCP-CLI parity

The MCP and CLI surfaces should map 1:1. Today the MCP folded `update_thread` to cover resolve/unresolve/reply, while the CLI splits them. Pick a model (probably MCP's), align both, document the mapping in `skills/vegastack-pages`.

---

## 9. Cron + retention + cleanup

Single nightly cron in the backend Worker. Order, with each step `ctx.waitUntil()`-fired so a slow one doesn't block the next:

1. **Symmetric version prune** (008 F-I): delete D1 rows + R2 objects for versions older than `workspace.version_retention_days` (default 30), except the current and newest. This was R2-only today.
2. **Auto-checkpoint cadence tightening** (008 §3.5): skip checkpoint when `contentHash === lastCheckpointHash`. Tunable cadence: keep 10-min default but only fire if the page mutated _and_ last checkpoint is ≥ 30 min ago.
3. **Auth session prune**: `DELETE FROM auth_sessions WHERE expires_at < ?`.
4. **Magic-link prune**: `DELETE FROM magic_links WHERE expires_at < ?`.
5. **Audit-log archival (optional)**: rows older than `VPG_AUDIT_RETENTION_DAYS` (default 365) move to an archival table. **DECISION needed**: 365 days OK as default? Recommendation: yes; envable for compliance.
6. **Backup-to-Git sync** (existing, unchanged).
7. **Render artifact backfill** (§4.4) — runs only while backlog > 0.

All steps respect a Worker CPU cap (`scheduled.waitUntil` can buy time but not infinitely); the cron splits work and resumes via a KV cursor.

---

## 10. Indexes + schema tightening

Drizzle migration adding the indexes 008 §K flagged:

```sql
CREATE INDEX idx_audit_logs_workspace_created ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX idx_page_versions_page_created ON page_versions(page_id, created_at DESC);
CREATE INDEX idx_comment_replies_thread_created ON comment_replies(thread_id, created_at);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);
```

Plus a one-shot data migration:

- Backfill `pages.frontmatter_json` for every existing page (extract via the same `renderMarkdown` pipeline).
- Backfill `pages.render_cache_key` (§4 makes it load-bearing).

Plus a schema cleanup:

- `search_documents.body_text` — drop. FTS5 keeps its own tokenized index. The row column is redundant. (008 §J.)

---

## 11. Anti-patterns to scrub from current code

These come straight from `workers-best-practices/SKILL.md` and `kv/gotchas.md`. We do or might do some of these; audit explicitly before deploy.

| Anti-pattern                         | Where to look                                                                                                                                                                                        | Skill ref                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Module-level mutable state in Worker | `apps/web/src/lib/runtime.ts` — the in-memory service maps are module-level. They're "hydrated" per request but the maps themselves leak across requests. After D1-direct landing (§6), delete them. | `workers-best-practices/SKILL.md:74, 304-331` |
| Destructuring `ctx`                  | grep for `const { waitUntil } = ctx` — should be zero.                                                                                                                                               | `workers-best-practices/SKILL.md:97, 161-166` |
| KV read-after-write                  | Audit any `await env.SESSIONS.put(...)` followed by `await env.SESSIONS.get(...)`.                                                                                                                   | `kv/gotchas.md:6-19`                          |
| Concurrent same-key KV writes        | Audit auth session creation paths for the "two requests rotating the same session token" race.                                                                                                       | `kv/gotchas.md:21-48`                         |
| Sync I/O in handlers                 | `await response.text()` on unbounded body — grep across the codebase. Stream attachments and source fetches.                                                                                         | `workers-best-practices/SKILL.md:96-141`      |
| `Math.random()` for IDs/tokens       | grep + replace with `crypto.randomUUID()` / `crypto.getRandomValues()`.                                                                                                                              | `workers-best-practices/SKILL.md:81, 375-389` |
| Hand-written `Env` interface         | We do this. Run `wrangler types` to generate.                                                                                                                                                        | `workers-best-practices/SKILL.md:39-61`       |

---

## 12. Phased rollout

**Phase 0 — pre-prod hygiene (1 day):**

- Bump Wrangler v3.109.2 → v4.92.0; run `wrangler types`; smoke-test local dev with the new CLI.
- Create R2 bucket `vegastack-pages-content`.
- Apply existing migrations against D1 production (currently 0 tables).
- Set secrets: `ASTRO_KEY`, `VPG_INTERNAL_KEY`, etc.

**Phase A — safe wins (one release window, 1–2 weeks):**

- Index migration (§10).
- ETag + If-None-Match on `/api/pages/*/source` and `/versions` (008 §4.1).
- Extract HTML preview runtime to `/public/vpg/html-preview-runtime.<hash>.js` (008 §6.1).
- Lazy CodeMirror language packs (008 §6.2).
- Conditional Mermaid + copy-button enhancers (008 §6.4).
- Wrangler config additions: observability already set; smart placement on backend; D1 read replica binding.
- MCP annotations + `outputSchema` (§7.1, §7.2).
- CLI `--json` + shared `OnceCell<Client>` + gzip (§8.1).

These are all isolated, low-risk, each fits a single PR.

**Phase B — render artifact (one focused release):**

- Pre-render artifact on write with `RENDERER_VERSION` (§4).
- `frontmatter_json` + `render_cache_key` become load-bearing (§4, §10 backfill).
- `search_documents.body_text` slimming (§10).
- Resumable backfill cron (§4.4).

This is one PR plus a one-shot backfill via Worker cron. Run the backfill _before_ flipping the read path to artifact-first.

**Phase C — runtime layer rewrite (the structural unlock):**

- D1-direct repo adapters (§6).
- Drop runtime mutation lock + `persistRuntimeState`.
- This is the workstream A unlock from 007. Largest PR; gated by careful test coverage.

**Phase D — Astro modernization (after the perf landings settle):**

- Adopt `<ClientRouter />`; drop the shell controller mount (§5.1).
- Server-island migration for comments-stats / favorites / permissions (§5.3).
- Migrate write API routes to Astro Actions (§5.4) — large diff, do as one PR per resource family.

**Phase E — MCP/CLI rebuild:**

- MCP composition tools (`vpg_prepare_page_edit_v2`, `vpg_list_comments_since`, `vpg_get_page` with `include:`) (§7.4).
- MCP `vpg_` namespace migration with aliases (§7.3).
- Improved error messages (§7.6).
- CLI noun-verb taxonomy + shell completions (§8.1).
- MCP-CLI parity audit + documentation (§8.3).

**Phase F — cron + cleanup:**

- Nightly cron handler (§9).
- Hash-equality skip on auto-checkpoint.
- Magic-link/session prune.
- Optional audit archival.

Phases A, B, C, D, E, F can pipeline — A unblocks nothing else, B requires nothing else, C and D both depend on A's index migration but are otherwise independent, E and F are independent of everything except shared CI capacity.

---

## 13. Non-regression guarantees

| Guarantee                       | How this plan preserves it                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Source durability in R2         | All new writes are additive; no source bytes change semantics                         |
| Audit completeness              | §9 archival respects `VPG_AUDIT_RETENTION_DAYS`; never deletes outside retention      |
| Optimistic concurrency on patch | `base_version_id` semantics unchanged in §7.4 composition tool                        |
| Comments survive rerenders      | Anchors key by `contentHash`; artifact is keyed by `contentHash` + `RENDERER_VERSION` |
| Permissions on cached responses | Public-only edge cache; workspace SSR stays `private, no-store`                       |
| Backup-to-Git fidelity          | Source is the source of truth; rendered artifacts never enter the backup              |
| Self-host (Node) parity         | Every CF binding has a Node-adapter equivalent; the renderer code is identical        |
| MCP backward compat             | §7.3 ships aliases for one release before deprecating unprefixed names                |
| CLI backward compat             | Old verb-first commands kept as aliases for one release                               |

Tests to add per phase, beyond the existing 349:

- Phase A: ETag round-trip on `/api/pages/*/source`; folder cache-header parity (already covered, but pin it); MCP annotations present on every tool descriptor; CLI `--json` produces parseable JSON.
- Phase B: artifact write → read round-trip (byte-equal to live render); read-path fallback when artifact missing; backfill cron resumes from cursor; `RENDERER_VERSION` mismatch triggers re-render.
- Phase C: D1-direct repo passes the same service tests as in-memory; lock removal doesn't introduce write-ordering bugs (concurrent mutation tests).
- Phase D: ClientRouter doesn't break existing handlers; server islands hydrate without auth leak.
- Phase E: MCP cursor pagination terminates; alias tools produce identical results.

---

## 14. Open decisions I need from you

These are the points where directional alignment matters. My recommendation is in parentheses.

1. **Two-Worker vs three-Worker split.** (Two — edge + backend; MCP on backend.)
2. **`RENDERER_VERSION` source.** Build-time computed constant, or runtime env var? (Build-time.)
3. **Public R2 bucket via custom domain, or proxy through Worker?** (Proxy through Worker so auth/password/cache headers stay in one place.)
4. **Adopt `<ClientRouter />` and drop the cycle-4 shell controller mount?** (Yes; F-017 disappears.)
5. **Astro Actions migration for browser-side mutations?** (Yes, Phase D — non-blocking.)
6. **MCP `vpg_` prefix rollout: aliased or breaking?** (Aliased for one minor release, then drop.)
7. **CLI noun-verb rename: aliased or breaking?** (Aliased for one minor release.)
8. **D1 paid tier (read replication).** Required for Phase A's replica binding to actually work — confirm budget alignment. (Recommend paid for managed; self-host stays single-DB.)
9. **`VPG_AUDIT_RETENTION_DAYS` default 365 days.** (Yes, configurable.)
10. **Telemetry on the CLI (opt-out).** (Yes, anonymized command-name counts only.)
11. **Wrangler v3 → v4 upgrade.** Bump directly in `feat/instant-workspace-v1` or on `develop`? (Develop branch first.)
12. **Backfill cron pace.** 20 pages/min is conservative — confirm or raise? (20/min; can revisit after first observation.)

---

## 15. What I'm NOT proposing (and why)

- **Durable Objects for per-workspace cache** — D1 reads with read replicas + per-request memoization are simpler and sufficient. DOs add a hibernation/coldstart story we don't need.
- **Hyperdrive** — for external Postgres; we're D1-native. Skill: `workers-best-practices/SKILL.md:239-262`.
- **Workers Static Assets binding for everything** — appropriate for `dist/client` but not for our rendered HTML; the artifact cache is keyed by content hash, not path.
- **Vectorize** — no current consumer; semantic search would be a separate plan.
- **Workers AI** — out of scope for the doc-publishing surface.
- **Switching off Astro to a hand-rolled SSR** — Astro 6's surface (server islands, ClientRouter, Actions) is where we'd reinvent if we left.
- **Workers Sites old-style** — deprecated; we use the new `assets` binding pattern.

---

## 16. Reading list cited in this plan

- `.agents/skills/cloudflare/references/workers/api.md` — Cache API patterns.
- `.agents/skills/cloudflare/references/workers/patterns.md` — service binding + Cache patterns.
- `.agents/skills/cloudflare/references/d1/patterns.md` — D1 batch + Sessions API + read replicas.
- `.agents/skills/cloudflare/references/d1/gotchas.md` — replication lag, prepared statement rules.
- `.agents/skills/cloudflare/references/kv/patterns.md` — KV TTL + session patterns.
- `.agents/skills/cloudflare/references/kv/gotchas.md` — eventual-consistency rules, concurrent writes.
- `.agents/skills/cloudflare/references/smart-placement/patterns.md` — fetch-binding requirement.
- `.agents/skills/cloudflare/references/static-assets/patterns.md` — Workers Static Assets binding.
- `.agents/skills/workers-best-practices/SKILL.md` — module state, ctx, security headers, bindings hygiene.
- `.agents/skills/wrangler/SKILL.md` — config shapes + observability + cron.
- `/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/guides/view-transitions.mdx` — ClientRouter.
- `/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/guides/server-islands.mdx` — server:defer.
- `/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/guides/actions.mdx` — typed RPC.
- `/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/guides/on-demand-rendering.mdx` — prerender.
- `/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/guides/middleware.mdx` — middleware.
- MCP spec 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Anthropic "Writing tools for agents": https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic "Code execution with MCP": https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic "Effective harnesses for long-running agents": https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Cloudflare "How we design features for Wrangler": https://blog.cloudflare.com/how-we-design-features-for-wrangler/
- gh CLI scripting: https://github.blog/engineering/engineering-principles/scripting-with-github-cli/

---

End of plan. Awaiting decisions on §14 before opening any PR.
