---
title: Navigation latency root-cause + safe refactor plan
date: 2026-05-20
status: draft — awaiting approval
owner: mk@vegastack.com
---

# 014 — Navigation latency: honest diagnosis + no-breakage refactor plan

## TL;DR

Page-to-page navigation is **1–2s** because every authenticated nav does a full
SSR roundtrip with a permission-resolution N+1 inside it, and the response is
`Cache-Control: private, no-store` so Cloudflare's edge cannot help. Astro's
ClientRouter only masks this with a DOM morph — it does **not** make the
server faster. R2 / free egress / Workers locality are irrelevant: the
bottleneck is the **synchronous server work per request**, not the network.

The fix has three honest phases. None require breaking changes.

---

## 1. Where the 1–2s actually comes from

Evidence in [apps/web/src/pages/p/[slugId].astro](../../apps/web/src/pages/p/%5BslugId%5D.astro)
unless noted:

| #   | Symptom                                                                    | Lines                  | Cost per nav                |
| --- | -------------------------------------------------------------------------- | ---------------------- | --------------------------- |
| 1   | N+1 permission resolution over every workspace page                        | 315–328                | ~20–40 × D1 roundtrips      |
| 2   | `buildServiceContext()` called twice                                       | 47–50, 200–204         | 2× DB/object-store init     |
| 3   | Sequential folder waterfall (`listAll` → `ancestorPath` → `list` → perms)  | 279, 290–292, 307      | ~4 sequential awaits        |
| 4   | `Cache-Control: private, no-store` on every auth view                      | 192                    | edge can't cache            |
| 5   | Prefetch off by default (`hover` strategy)                                 | astro.config.mjs:59–62 | full SSR on click           |
| 6   | Sidebar data re-fetched every nav despite `transition:persist`             | 1219                   | re-query on every click     |
| 7   | Heavy islands (`CommandPalette`, `CommentsRail`) bundled into every layout | 1350, 1367             | hydration tax on each route |

The dominant terms are **#1** (N+1 perms) and **#5** (no prefetch). #4 means
we cannot lean on Cloudflare's HTML cache for authenticated users — but we
can still cache **inside** the Worker (Cache API, KV) and prefetch on the
client.

---

## 2. The four options — benefits, breakage, security (honest)

References below are to local Astro docs at
`/Users/kmanojkumar/code/ref-docs/astro-js-docs/src/content/docs/en/`.

### A. Client cache + bulk permissions (TanStack/Zustand)

- **Mechanism:** fetch pages/folders/perms once, cache in a client store,
  render sidebar from cache, invalidate on mutation.
- **Benefit:** biggest theoretical win (~100–200ms navs) **after** the first
  load. First load is unchanged.
- **What can break:**
  - Sidebar persisted via `transition:persist` ([slugId].astro:1219) — cache
    must replace server props cleanly or you get a flash of stale data.
  - Favorites toggle ([slugId].astro:439+) depends on fresh server data on
    every nav today; needs explicit invalidation on toggle.
  - `client:idle` islands (CommandPalette, CommentsRail) assume server-rendered
    data is current — staleness can produce hydration mismatches.
- **Security:** permission staleness is the real hazard. If an admin revokes
  access mid-session, the client cache still shows the page in the sidebar
  until next invalidation. We'd need short TTL + revalidate-on-focus + server
  re-check on actual page load (defence in depth — server stays authoritative).
- **Verdict:** worth doing, but **after** B. Too much surface to change first.

### B. Server-side bulk perms + viewport prefetch

- **Mechanism:** collapse the per-page permission loop ([slugId].astro:315–328)
  into **one** SQL with a join that returns `{page_id, can_read}` for the
  whole workspace. Dedupe `buildServiceContext()`. Flip
  `prefetch.defaultStrategy` to `viewport` and `prefetchAll: true`
  (see `guides/prefetch.mdx` — viewport strategy is the recommended default
  for app-like UIs).
- **Benefit:** realistic 600–900ms shaved per nav. Click-to-render becomes
  ~200–400ms on warm Workers. **Zero** UX risk.
- **What can break:** essentially nothing if SQL is equivalent. The risk is a
  buggy bulk query — covered by parity tests against the current loop.
- **Security:** the bulk query must filter by the actor server-side (same
  `resolveActorPermission` rules in one SQL). No client trust. Prefetch must
  honour the existing `Cache-Control: private, no-store` so prefetched HTML
  is not cached by intermediaries (Astro's prefetch respects response
  cache-control per `prefetch.mdx`).
- **Edge cases:** viewport prefetch on a long sidebar can spam the origin.
  Mitigation: `prefetchAll: false` + manual `data-astro-prefetch="viewport"`
  on sidebar links only; or keep `defaultStrategy: 'tap'` + explicit
  `viewport` for the sidebar.
- **Verdict:** the right first move. No breakage. Big win.

### C. Server-Timing measurement first

- **Mechanism:** emit a `Server-Timing` header from middleware (see
  `guides/middleware.mdx`) and log per-segment timings (auth, ctx-build,
  folders, pages, perms, render). Sample 10% to avoid observer effect.
- **Benefit:** zero latency win. Confirms which of (1)–(7) above actually
  dominates on real traffic before we cut code. ~30 min to add.
- **What can break:** nothing. Headers are diagnostic.
- **Security:** strip query/table names from header labels (use opaque
  segment names like `ctx`, `perm`, `folders`) so we don't leak schema.
- **Verdict:** do this **alongside** B, not before. It's cheap and tells us
  if perms are really the bottleneck (high confidence yes, but verify).

### D. Astro server islands + edge-cached shell

- **Mechanism:** split `AppLayout` into a cacheable shell + `server:defer`
  islands for the personalized parts (sidebar, breadcrumb). Per
  `guides/server-islands.mdx`, deferred islands fetch async with encrypted
  props.
- **Benefit:** ceiling is highest (sub-100ms first paint). Real-world: only
  pays off if the shell is static across many routes.
- **What can break:**
  - `server:defer` does **not** participate in View Transitions — each island
    re-fetches on every nav. That removes the `transition:persist` sidebar
    UX we have today.
  - Encrypted props have a 2 KB URL limit; large sidebars fall back to POST,
    which is uncacheable.
  - The anonymous publication fast-path ([slugId].astro:62–92) already serves
    static HTML from R2; layering server islands on top complicates that path.
- **Security:** island-prop encryption keys must be rotated and stored as
  secrets (we already use Wrangler secrets). No new class of risk if managed.
- **Verdict:** **not now.** Wrong trade-off for an app where the sidebar
  changes per workspace and we already have a smooth ClientRouter UX. Revisit
  only if first-paint becomes the goal after B+A are done.

---

## 3. Recommended plan (no breaking changes)

Execute in this order. Each phase is independently shippable behind no flag —
all changes are server-side query shape + Astro config + an opt-in client
cache.

### Phase 1 — Instrumentation (Option C). ~30 min.

1. Add `Server-Timing` emission in `apps/web/src/middleware.ts` for segments
   `auth`, `ctx`, `folders`, `pages`, `perms`, `render`.
2. Add a `?debug=timing` query that logs to console for dev only.
3. Capture a baseline: median + p95 nav time on develop deploy.

**Risk:** none. **Breakage:** none.

### Phase 2 — Server-side bulk perms + dedupe (Option B core). ~1 day.

1. Add `resolveActorPermissionsBulk(actor, pageIds[])` in `packages/core` —
   one SQL with a join, returns `Map<pageId, perm>`. Parity-test against the
   current loop with a fixture workspace.
2. Replace the loop at [slugId].astro:315–328 with the bulk call.
3. Hoist `buildServiceContext()` to a single call per request (memoize on
   `Astro.locals`).
4. Move folder ancestry + listAll into a single SQL where possible (or at
   least into a `Promise.all` with `list`).
5. Apply the same refactor to settings routes that share the sidebar.

**Risk:** SQL bug yielding wrong permissions. **Mitigation:** parity test
against the existing loop in CI; ship behind a dev-only env switch first
(`VPG_BULK_PERMS=1`) and remove the switch after one prerelease soak.
**Breakage:** none for users.

### Phase 3 — Prefetch (Option B prefetch). ~1 hour.

1. In `astro.config.mjs`: keep `prefetchAll: false`, set `defaultStrategy:
'tap'`.
2. In `Sidebar.tsx`/sidebar links: add `data-astro-prefetch="viewport"` so
   only sidebar links prefetch as they enter view.
3. Verify Astro prefetch honours `Cache-Control: private` (per docs, it uses
   `fetch` with credentials and does not bypass cache-control).

**Risk:** sidebar prefetch traffic spike. **Mitigation:** restrict to sidebar
only; monitor Worker requests on develop for one day.

### Phase 4 — Client cache for sidebar data (Option A, scoped). ~2 days.

Only if Phases 2–3 don't get us under ~400ms p95.

1. Introduce a Zustand store seeded from the first server render (pages,
   folders, favorites, perms).
2. Subsequent navs read sidebar data from the store; server still renders the
   main content authoritatively.
3. Mutations (rename, move, favorite, permission change) write through the
   store **and** invalidate via a small `/api/sidebar/refresh` ping.
4. Keep server as source of truth on every page render — the store is only a
   render-time hint for the persisted sidebar.

**Risk:** stale sidebar after out-of-band changes. **Mitigation:**
revalidate-on-focus + 60s background refresh + always re-seed on hard nav.
**Security:** server still resolves permissions on every page load — cache is
purely a render hint, not an authorization decision.

### Out of scope (explicitly): Option D

Server islands would require redesigning the persisted-sidebar UX and
complicate the anonymous publication fast-path. Not worth it until Phase 4
is measured.

---

## 4. Acceptance criteria

- p95 in-workspace navigation < 400ms (warm Worker, US-East colo).
- No regression in: favorites toggle, sidebar drag-and-drop, permission
  changes propagating within 60s, anonymous publication fast-path,
  ClientRouter view-transitions, MCP edits reflected on next nav.
- No new client-side permission decisions — server remains authoritative.
- Server-Timing headers present in develop only; stripped from production
  by default.

---

## 5. Open questions before I start

1. Is there a known fixture workspace (size, perm matrix) we can use for the
   bulk-perms parity test, or should I generate one?
2. Should Phase 1 instrumentation be gated to `develop` only, or also enabled
   in production with sampling?
3. Are the settings routes (`apps/web/src/pages/settings/**`) in scope for
   Phase 2 in the same PR, or a follow-up?
