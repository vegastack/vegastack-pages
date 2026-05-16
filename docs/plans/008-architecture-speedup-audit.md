# 008 — Architecture Speed-Up Audit (post-007 deltas)

Status: Draft for review.
Owner: K Manoj Kumar.
Relationship to 007: This plan is **additive** to `007-instant-workspace-architecture.md`. Plan 007 fixes the load-bearing structural issues (edge/backend split, removing the global lock and module-level runtime state, Smart Placement, D1 replicas, shell + server islands, ClientRouter removal). This document captures every additional architecture-level perf opportunity surfaced during a ground-up re-audit (apps/web, packages/{core,db,services,renderer}, cli/vegastack-pages, install/cloudflare). Everything here is backward-compatible and preserves all functionality: comments, versions, permissions, attachments, publications, audit, Backup-to-Git.

The north star: a published page should reach the user in the same envelope a Mintlify or GitBook page does — static-immutable bytes streamed from Cloudflare's edge cache with **zero render work on the worker on a cache hit**, while keeping our agent-edit + comments + versions semantics intact behind the same URL.

---

## 1. Diagnosis at a glance (what 007 does not fully cover)

| #   | Finding                                                                                                                                                              | File:line                                                                                                    | Plan-007 coverage                                                                              | Action class                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| A   | Markdown → HTML re-renders on every request; `renderCachedMarkdown` is a per-isolate 100-entry LRU only                                                              | `apps/web/src/lib/render-cache.ts:1-35`, `apps/web/src/pages/p/[slugId].astro:172`                           | 007 §15 mentions content-hash edge cache for the _response_, not the rendered-HTML artifact    | **P0 — Pre-render artifact**           |
| B   | 660-line inline JS runtime injected into every HTML-page iframe `srcdoc`                                                                                             | `apps/web/src/pages/p/[slugId].astro:379-1041`                                                               | Not covered                                                                                    | **P1 — Asset extraction**              |
| C   | Folder publication route is missing the public-cache header block                                                                                                    | `apps/web/src/pages/f/[slugId].astro:98-128` (vs `p/[slugId].astro:104-147`)                                 | 007 §15 talks about `/p/*` only                                                                | **P0 — Parity fix**                    |
| D   | Sidebar + breadcrumb load all workspace folders/pages on every page render                                                                                           | `apps/web/src/pages/p/[slugId].astro:193-238`                                                                | 007 ships shell + payload API; this finding is about the _initial_ SSR payload size            | **P1 — Tree pagination**               |
| E   | Comments stats use `listForPage("all")` (loads all threads + replies) just to count                                                                                  | `apps/web/src/pages/p/[slugId].astro:323-334`                                                                | 007 §10 makes comments stats a server island; still loads all rows                             | **P1 — Count query**                   |
| F   | Frontmatter parsed from R2 source on every render; `pages.frontmatter_json` column exists but is never populated                                                     | `packages/db/src/schema.ts:190-193`, `apps/web/src/lib/runtime.ts:2642`                                      | Not covered                                                                                    | **P1 — Denormalize title/frontmatter** |
| G   | `pages.render_cache_key` column declared but never written                                                                                                           | `packages/db/src/schema.ts:196`                                                                              | Not covered (007 puts the cache in Cloudflare Cache API; the column is dead weight either way) | **P2 — Drop column or use it**         |
| H   | Auto-checkpoint default 10 min → ~144 R2 writes/page/day even on dormant docs                                                                                        | `packages/core/src/page-service.ts:248-254`                                                                  | Not covered                                                                                    | **P2 — Tune cadence**                  |
| I   | Version prune deletes R2 objects but leaves `page_versions` rows in D1; tables grow forever                                                                          | `apps/web/src/lib/runtime.ts:1908-1962`                                                                      | Not covered                                                                                    | **P2 — Symmetric prune**               |
| J   | `search_documents.body_text` stores full source duplicated from R2 on every update                                                                                   | `packages/db/src/schema.ts:610-642`                                                                          | Not covered                                                                                    | **P2 — FTS-only storage**              |
| K   | Missing indexes: `audit_logs(workspace_id, created_at)`, `page_versions(page_id, created_at)`, `comment_replies(thread_id, created_at)`, `auth_sessions(expires_at)` | migrations dir                                                                                               | Not covered                                                                                    | **P1 — Index migration**               |
| L   | `/api/pages/{pageId}/source` and `/versions` send no `ETag` / `Cache-Control`, so agents and the editor can't 304                                                    | `apps/web/src/pages/api/pages/[pageId]/source.ts:28-57`, `versions.ts:18-43`                                 | 007 §15 addresses public HTML; not agent JSON                                                  | **P1 — JSON 304**                      |
| M   | Auth sessions and magic links accumulate forever — no expiry cleanup cron                                                                                            | `apps/web/src/lib/runtime.ts` session hydration                                                              | Not covered                                                                                    | **P2 — Cleanup cron**                  |
| N   | CLI uses three independent `reqwest::blocking::Client` builds; no keep-alive reuse, no `gzip`, no parallel ops for bulk operations                                   | `cli/vegastack-pages/src/main.rs` ApiClient sites                                                            | Not covered                                                                                    | **P1 — CLI HTTP**                      |
| O   | MCP common agent loop is 6–7 round-trips (`list_workspaces → list_pages → get_page → patch → wait → list_comments → reply`); resource endpoint underused             | `apps/web/src/pages/mcp.ts`, `packages/mcp/src/*`                                                            | Not covered                                                                                    | **P1 — MCP fold**                      |
| P   | `SonnerHost` is `client:load`, hydrates eagerly even on read-only public pages                                                                                       | `apps/web/src/layouts/AppLayout.astro` (Sonner host mount)                                                   | Not explicitly covered                                                                         | **P2 — Hydration tier**                |
| Q   | CodeMirror language packs bundled together; Markdown viewer pulls HTML lang module too                                                                               | `apps/web/src/scripts/page-editor-codemirror.ts` (and `package.json:@codemirror/lang-html`, `lang-markdown`) | Not covered                                                                                    | **P2 — Dynamic lang import**           |
| R   | Astro `prefetch.defaultStrategy: "hover"` keeps cold-start cost on first visit                                                                                       | `apps/web/astro.config.mjs`                                                                                  | Indirectly mitigated by shell                                                                  | **P2 — Tune prefetch**                 |
| S   | Mermaid theme observer installs unconditionally; copy-button enhancer scans every page                                                                               | `apps/web/src/scripts/prose-enhancements.ts`                                                                 | Not covered                                                                                    | **P3 — Conditional enhancers**         |

> Severities: **P0** = enables the Mintlify-class instant-load promise. **P1** = significant tail-latency or memory wins, safe to ship behind 007. **P2** = cleanup that pays back over weeks/months. **P3** = polish.

---

## 2. The Mintlify-class instant-load track (P0)

This is the single biggest architectural lever, and it is _not_ fully solved by 007's edge-cache plan. 007 caches the **response** keyed by URL + content hash, so the second visitor in the same colo is fast; the **first** visitor (and every cache-cold colo) still pays the full markdown render. Mintlify is fast for first-visitor-in-colo because there is nothing to render at request time — the bytes already exist.

### 2.1 Pre-rendered HTML artifact, stored in R2

**Today.** On publish or source save, we write `current.{md,mdx,html}` and a versioned object to R2. The renderer never runs until the next page-view request.

**Change.** On every successful source write (`PageService.updateSource`, `packages/core/src/page-service.ts`), additionally:

1. Run `renderMarkdown(source)` once.
2. Persist the output (HTML + `headings[]` + `frontmatter`) as `pages/{wsId}/.../renders/{contentHash}.json` in R2. Reuse the existing object-store abstraction; no new binding.
3. Set `pages.render_cache_key = "{contentHash}"` in D1 in the same transaction so reads can lookup-by-hash without scanning R2 listings. (Column already exists at `packages/db/src/schema.ts:196`; this kills Finding G.)

**Read path (`apps/web/src/pages/p/[slugId].astro`).**

```
if (page.renderCacheKey === page.contentHash) {
  rendered = await contentStore.getJson(`pages/.../renders/${contentHash}.json`)
}
if (!rendered) {
  rendered = await renderCachedMarkdown(...)  // existing fallback
  // fire-and-forget repair: write artifact for next visitor
}
```

**Why this is safe.**

- Same `renderMarkdown(...)` function on both write and fallback paths → byte-identical output.
- Fallback covers the case where the renderer (Shiki version, plugins) is upgraded: the next visitor regenerates the artifact for the new content hash. We could also bump a `RENDERER_VERSION` env var and concatenate into the cache key if we want explicit invalidation control.
- HTML pages have no render step; we already short-circuit `isHtmlPage`.

**What this costs us.**

- One extra R2 PUT per source write (~5–50 KB).
- A few hundred ms of CPU at write time (the cost is paid by the agent, who already pays it anyway because the next reader was going to incur it on the cold render).

**What this saves us.**

- The Cloudflare Cache API already covers warm-edge reads in 007. For _cold-edge_ and _workspace-authenticated_ reads, we go from `parse + Shiki + sanitize + stringify` (≈150–500 ms for a 100 KB doc with code blocks) to a single R2 GET. R2 GETs in the same region are typically 5–15 ms.
- Removes the per-isolate LRU as the only render-side optimization. The artifact survives isolate churn and colo switches.

**Combined with 007's edge cache.** Public publications get the best of both: edge cache serves byte-identical bodies on warm hits; cold hits or revalidation pulls the precomputed artifact from R2 with no compute.

### 2.2 Publish-time SEO HTML for indexable publications

Where `publication.indexingEnabled && !passwordHash`, also persist a "shareable" HTML envelope (full `<html>...</html>`, no shell chrome) at `pages/.../renders/{contentHash}.public.html`. This lets us:

- Serve it directly from a future `/embed/...` endpoint with `Cache-Control: public, immutable`.
- Hand it to Backup-to-Git as a built artifact (today the GitHub sync ships only source).

Strictly additive; no impact on existing routes.

### 2.3 Folder-page parity (Finding C)

Port the public-cache header block from `apps/web/src/pages/p/[slugId].astro:104-147` to `apps/web/src/pages/f/[slugId].astro` so folder publications are edge-cacheable on the same terms (ETag = `contentHash` of the folder's stable signature: hash of `(folderId, publicationUpdatedAt, sortedChildVersionIds)`). Cookie-vary applies only on password-gated folders.

Why this matters: a Mintlify-style folder landing today never hits the edge cache because the route always sets `Cache-Control: private, no-store`.

---

## 3. Storage and data shape (P1–P2)

### 3.1 Denormalize page metadata (Finding F)

`pages.frontmatter_json` and `pages.title` should be the source of truth for sidebar/search/breadcrumb so neither the worker nor the renderer needs to parse the R2 body just to know a title.

- On `updateSource`, extract `frontmatter` via the existing renderer pipeline and write to D1 columns: `title` (already there but only updated by the explicit rename API), `frontmatter_json`, optionally `description` and `tags`.
- Sidebar/breadcrumb queries (`pageService.listPages`) already read from D1 only — no behavioral change, but the cached `title` becomes authoritative.
- One-shot backfill migration: rehydrate every existing page's frontmatter once.

Backward-compatible: render still recomputes the same fields at read time and would simply overwrite stale values if the source changed out-of-band.

### 3.2 Symmetric version prune (Finding I)

`pruneExpiredVersions` in `apps/web/src/lib/runtime.ts:1908-1962` deletes R2 objects but leaves D1 rows. Update the cron to also `DELETE FROM page_versions WHERE id IN (...)` in the same batch. This:

- Stops the table from growing to 100k+ rows per active workspace.
- Tightens `listVersions` hot path which currently scans without a `created_at` index.

Pair with Finding K's index migration.

### 3.3 Search index slimming (Finding J)

Stop storing full `body_text` in the row-store `search_documents` table — keep it only in `search_documents_fts` (the FTS5 virtual table). FTS5 stores its own tokenized index; the row copy is redundant. The query path that builds snippets uses `snippet(search_documents_fts, ...)` which reads from the FTS table.

Net effect: cuts D1 storage on doc-heavy workspaces by an order of magnitude. Functionally identical search results.

### 3.4 Index migration (Finding K)

Single migration adding:

```sql
CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_created
  ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_versions_page_created
  ON page_versions(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_replies_thread_created
  ON comment_replies(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
  ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires
  ON magic_links(expires_at);
```

Drizzle migration only; no data change. D1 builds the indexes in the background on apply.

### 3.5 Auto-checkpoint cadence (Finding H)

Current default: every 10 minutes. For pages an agent is iterating on, that produces 144 versions/day of mostly-identical content. Two cheap fixes, both backward-compatible:

1. Skip the checkpoint when `contentHash === lastCheckpointHash`. (R2 PUT still happens for "current" but no version row is created.)
2. Make the cadence content-aware: checkpoint only if the source has been mutated since the last checkpoint _and_ at least N minutes (default 30) have passed.

Both keep "manual snapshot" and "every meaningful change keeps a version" intact.

### 3.6 Session and magic-link cleanup (Finding M)

Extend the existing cron handler in `apps/web/src/worker.ts:13-19` to also run:

```sql
DELETE FROM auth_sessions WHERE expires_at < ?;
DELETE FROM magic_links   WHERE expires_at < ?;
```

Once per night. Cheap. Removes the slow accumulation of stale rows in the auth tables.

---

## 4. JSON API contract polish (P1)

### 4.1 Conditional source fetches (Finding L)

`apps/web/src/pages/api/pages/[pageId]/source.ts` and `…/versions.ts` should advertise an `ETag` and honor `If-None-Match`. Use the existing `contentHash` (for source) and a SHA-256 of `(pageId, latestVersionCreatedAt, count)` (for versions list).

Why this matters: the editor on `/p/{id}` polls `source.ts` to detect upstream edits. Today the worker re-fetches the full payload from D1+R2 every poll. With 304s, the round-trip becomes ~3 ms with zero body bytes. Also helps Backup-to-Git incremental sync and CLI `vpg pages pull`.

### 4.2 Drop `Cache-Control` from authenticated JSON, add `Vary: Cookie` where missing

Audit every API route for missing `Vary` declarations; the password-gate hardening (007 §10) only protected `/p/*`. Routes under `/api/comment-threads/*` and `/api/pages/*` should set `Cache-Control: private, no-store` explicitly so a misconfigured upstream cache cannot reuse a response.

---

## 5. CLI + MCP track (P1)

### 5.1 Rust CLI HTTP layer (Finding N)

- Promote the three `Client` builders into a single lazy `OnceCell<Client>` at module scope. Reuse across commands → real keep-alive, real TLS session resumption.
- Enable `gzip` and (where the dependency tree allows) `brotli` decompression: `reqwest = { features = ["json", "gzip", "rustls-tls"] }`.
- Send `Accept-Encoding: gzip, br`. Combine with 4.1 above for `If-None-Match` so `vpg pages pull` and `vpg watch` are <5 KB per check on a no-op revalidation.
- Bulk paths (`vpg pages import`, attachment uploads): use `tokio` + `futures::stream::buffer_unordered(8)` to fan out HTTP work. Keep a serial fallback flag for debugging.

None of this changes the wire contract.

### 5.2 MCP tool fold (Finding O)

Two surgical additions, no breaking changes:

1. **`get_page_for_edit` (composition tool).** Returns `{ page, source, base_version_id, base_content_hash, open_comment_threads, latest_versions[5] }` in one call, replacing the 3-call pattern (`get_page` + `list_comments` + `listVersions`) agents typically run before editing. Internally calls existing services in parallel via `Promise.all`. Old tools remain.
2. **`list_comments_since` (incremental fetch).** Accepts `since: ISO timestamp`, returns only threads/replies created or updated after that timestamp + a server-supplied `cursor`. Agents in a wait-loop currently re-fetch all threads on every poll.

Document the existing `resources/list` + `resources/read` endpoints in `skills/vegastack-pages` so agents are nudged toward `vpg://pages/{id}` reads when they only need source (no perm filter overhead) instead of always going through the tool API.

### 5.3 Atomic patch on stale base version

`patch_page` already enforces optimistic concurrency via `base_version_id`. Add a server-side response field `latest_base_version_id` on 409 conflicts so agents can `get_page_for_edit` + retry without first calling `versions.ts` to find the new id. Pure addition.

---

## 6. Client bundle, hydration, prose enhancers (P1–P3)

### 6.1 Extract the HTML preview runtime (Finding B)

Move `htmlPreviewRuntimeScript(...)` (`apps/web/src/pages/p/[slugId].astro:379-1041`) to `apps/web/public/vpg/html-preview-runtime.js`, hashed at build time. The iframe injector inlines a tiny `<script nonce="...">` that imports it via `<script type="module" src="/vpg/html-preview-runtime.<hash>.js">`. CSP allows the asset URL.

Today this script is ~20 KB of source per HTML-page response, parsed and never cached. After extraction:

- One cacheable file. `Cache-Control: public, immutable, max-age=31536000`.
- Removes ~20 KB from every HTML-page server response.
- The nonce model still works; we just put it on a single `<script>` tag.

### 6.2 Lazy CodeMirror language packs (Finding Q)

`apps/web/src/scripts/page-editor-codemirror.ts` imports `@codemirror/lang-markdown` and `@codemirror/lang-html` statically. Switch to dynamic import keyed on `sourceType`:

```ts
const langModule =
  sourceType === "html"
    ? await import("@codemirror/lang-html")
    : await import("@codemirror/lang-markdown");
```

Removes the unused language pack from the page-editor chunk (≈40 KB before gzip per pack).

### 6.3 Hydration tier audit (Finding P)

- `SonnerHost`: demote to `client:idle` everywhere except routes that may emit a toast during SSR settling (signup error pages).
- `CommandPalette`: already `client:idle`; verify it dynamic-imports `cmdk` only on first open.
- `CommentsRail`: already `client:idle`; we can also lazy-load the slide-over body so the rail's button-stub is the only initial cost.

### 6.4 Conditional prose enhancers (Finding S)

In `apps/web/src/scripts/prose-enhancements.ts`:

- Skip Mermaid theme observer install when `document.querySelectorAll('.mermaid-block').length === 0`.
- Make the copy-button enhancer scope to `[data-vpg-prose] pre` rather than scanning the whole document.

These are inconsequential individually but together cut the per-page enhancer cost to a few hundred microseconds on doc-heavy workspaces with no diagrams.

### 6.5 Astro prefetch tuning (Finding R)

After 007 lands the shell controller, `prefetch.defaultStrategy: "hover"` becomes a quirk: shell-driven nav already fetches partials on hover-with-intent. Keep prefetch but add `data-astro-prefetch="false"` to the sidebar/breadcrumb anchors that the shell already handles. Avoids duplicate fetches and frees the prefetch slot for cross-shell navigation (`/app`, `/docs/*`).

---

## 7. Cron, retention, and operational cleanup

A single nightly cron handler should run, in order:

1. Version prune (existing) — now also deletes D1 rows.
2. Auth session prune.
3. Magic link prune.
4. (Optional) Audit log archival to a separate `audit_logs_archive` table for rows older than `VPG_AUDIT_RETENTION_DAYS` (default 365), keyed by workspace.
5. Backup-to-Git sync (existing).

All changes are additive and feature-flagged via env (`VPG_PRUNE_VERSIONS_DB`, `VPG_PRUNE_SESSIONS`, …). Default-on in managed; default-off self-host first release so operators can opt in.

---

## 8. Safety, durability, and non-regression guarantees

| Guarantee                        | How this plan preserves it                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source is durable in R2          | All P0/P1 changes are additive to R2 writes; we never replace source as source of truth                                                                                     |
| Audit completeness               | Soft-delete or archive paths preserve audit rows; cleanup respects `VPG_AUDIT_RETENTION_DAYS`                                                                               |
| Comments survive rerenders       | Pre-rendered artifact is keyed by `contentHash`; comment anchors already key by `contentHash`. Restoring an old version regenerates the matching artifact deterministically |
| Optimistic concurrency on patch  | `base_version_id` semantics unchanged. The new `get_page_for_edit` tool returns the same value it always did                                                                |
| Permissions on cached responses  | Workspace-authenticated routes keep `private, no-store`; only public-publication routes get edge-cached, gated by ETag that includes publication state                      |
| Backup-to-Git fidelity           | Plan only adds an optional rendered-HTML artifact to the manifest; the agent contract (source-only) is unchanged                                                            |
| Multi-runtime parity (CF / Node) | Every new persistence write goes through the existing object-store and D1 abstractions; the Node adapter inherits the same code path                                        |

A regression-net of tests to add as part of this work:

1. Render-artifact round-trip: write → fetch → assert byte-equal to a fresh `renderMarkdown` pass.
2. Folder publication: anonymous GET returns 200 + `Cache-Control: public, max-age=...`, second GET with `If-None-Match` returns 304.
3. ETag on `/api/pages/{id}/source` returns 304 when `If-None-Match` matches `contentHash`.
4. `get_page_for_edit` returns `base_version_id` byte-equal to `get_page().base_version_id`.
5. Version prune cron deletes D1 rows + R2 objects + leaves the latest version and the current alive.
6. `pruneExpiredSessions` deletes only past-expiry rows.

---

## 9. Sequencing and risk

We assume Plan 007 lands first (it's already on `feat/instant-workspace-v1`). After 007 merges:

**Phase A (within one release window, P0+P1 safe wins):**

- Folder route public-cache parity (§2.3).
- Index migration (§3.4).
- Conditional source/versions ETags (§4.1).
- HTML preview runtime extraction (§6.1).
- CodeMirror lazy language packs (§6.2).
- Mermaid/copy-button conditional install (§6.4).

These are isolated, low-risk, each fits a single PR.

**Phase B (P0 instant-load, one focused release):**

- Pre-render artifact on write (§2.1).
- Frontmatter denormalization + backfill (§3.1).
- `pages.render_cache_key` becomes load-bearing (replaces Finding G).
- Search `body_text` slimming (§3.3).

These touch the page-service write path and want a single PR + a one-shot backfill migration. Run the backfill in a Worker cron job rather than a deploy step so it can resume.

**Phase C (P1 agent perf):**

- CLI HTTP layer (§5.1).
- MCP `get_page_for_edit` and `list_comments_since` (§5.2).
- 409-conflict response includes `latest_base_version_id` (§5.3).
- Resource endpoint documentation in `skills/vegastack-pages`.

Self-contained, agent-side rollout. Old MCP clients keep working unchanged.

**Phase D (P2 cleanup):**

- Auto-checkpoint cadence (§3.5).
- Symmetric version prune (§3.2).
- Session + magic-link prune cron (§3.6).
- Optional audit-log archive (§7).

Default-flag-off until we have a release window to validate retention behavior in managed hosting.

---

## 10. Open questions for the maintainer

1. **Render-artifact storage location.** Keep it in the same R2 bucket as source (separate prefix `pages/.../renders/`) or split to a second bucket for clearer cost attribution? Recommendation: same bucket, same lifecycle policy as `versions/`.
2. **Renderer-version key.** Should the artifact key be `{contentHash}.json` or `{contentHash}.{rendererVersion}.json`? Recommendation: include `RENDERER_VERSION` so a Shiki/MDX bump invalidates the artifact for everyone with one env var bump.
3. **Self-host pre-render trigger.** On managed we have a cron; on Node we can do the artifact write inline in `updateSource`. Confirm that an extra 100–300 ms in the CLI/MCP write response is acceptable. Recommendation: yes — same agent that pays this cost would have paid it on the next read anyway.
4. **Audit-log retention default.** 365 days is conservative; managed legal/compliance may want 7 years. Confirm before defaulting.
5. **MCP composition tool naming.** `get_page_for_edit` or `prepare_page_edit_v2`? The current `prepare_page_edit` is similar but returns less; we either extend it (breaking change) or ship a new tool (safe).

---

## Appendix A — File/line index for the next implementer

- `apps/web/src/pages/p/[slugId].astro:104-147` — public cache header logic to clone into `f/[slugId].astro`.
- `apps/web/src/pages/p/[slugId].astro:172-176` — `renderCachedMarkdown` call; insert R2 artifact lookup _before_ this.
- `apps/web/src/pages/p/[slugId].astro:323-334` — comment stats; switch to `commentService.countByStatus(pageId)` after server-island migration in 007.
- `apps/web/src/pages/p/[slugId].astro:379-1041` — HTML preview runtime to extract.
- `apps/web/src/pages/f/[slugId].astro:98-128` — cache-control block missing.
- `apps/web/src/pages/api/pages/[pageId]/source.ts:28-57` — add ETag + 304.
- `apps/web/src/pages/api/pages/[pageId]/versions.ts:18-43` — add ETag + 304.
- `apps/web/src/lib/render-cache.ts:1-35` — keep as fallback; not the primary cache layer.
- `apps/web/src/lib/runtime.ts:1326-1448` — hydration (007 already removes this; mentioned for context).
- `apps/web/src/lib/runtime.ts:1908-1962` — version prune; add D1 row delete.
- `packages/db/src/schema.ts:173-205` — pages table; `frontmatter_json`, `render_cache_key` become populated.
- `packages/db/src/schema.ts:610-642` — search_documents; drop `body_text` column from row store.
- `packages/core/src/page-service.ts:248-254` — auto-checkpoint cadence.
- `cli/vegastack-pages/src/main.rs` ApiClient sites — single shared `Client` with gzip.
- `apps/web/src/pages/mcp.ts` — register the two new tools.
- `apps/web/src/worker.ts:13-19` — extend cron handler.
- `apps/web/astro.config.mjs:prefetch` — keep, document the shell-anchor opt-out.

---

Tracking decisions to confirm before any PR opens: §10 questions 1–5. Everything else is ready to implement under existing CLAUDE.md / AGENTS.md rules: local edits only, no remote mutation, ship through the standard changeset + release-gate flow.
