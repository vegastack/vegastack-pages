---
"@vegastack/pages": patch
---

Clean-slate rebuild of the architecture for production launch (plan 010).

- **Schema**: squashed 21 SQL migrations into a single canonical
  `0001_init.sql` plus a tiny `0002_oauth_seed.sql` for the two
  well-known OAuth clients. Four legacy elements (`runtime_state`,
  `runtime_locks`, `pages.render_cache_key`, `comment_anchors.reanchor_status`)
  are retained behind `-- Legacy …` comments until the data-layer
  rewrite removes the snapshot/lock machinery.
- **Wrangler config**: `apps/web/wrangler.jsonc` is now the canonical,
  version-controlled deploy config (replaces the release-workflow
  generator block). Enables Smart Placement, full observability
  (100% sampling + invocation logs), Workers Images binding, per-user
  rate-limiting binding, nightly GitHub-backup cron, and the
  Cloudflare `send_email` binding for outbound email fallback.
- **Email**: outbound transactional mail (magic links) primarily via
  AWS SES (SigV4 SendRawEmail). Cloudflare's `send_email` binding is
  the secondary path plus the canonical reply path inside Email
  Routing's `email()` inbound handler. `VPG_EMAIL_PROVIDER=auto`
  picks SES when AWS\_\* secrets are present, falls back to the
  Cloudflare binding when only `EMAIL` is bound, else dev/console.
- **Astro 6 + Cloudflare adapter v13 canonical patterns**: typed `Env`
  via `wrangler types`, `ClientRouter` + `transition:persist` on
  Sidebar / PageHeader / CommandPalette / CommentsRail / SonnerHost /
  MobileTabBar, and font display `swap` with narrowed weights.
- **Consolidation**: single error class (`AppError`), single envelope
  helper (`jsonWithEnvelope`), single runtime discriminator
  (`VPG_RUNTIME`), single permission helper module (`access.ts`),
  single URL prefix for the app (`/app/*`).
- **Reliability**: the per-request D1 batch buffer is now scoped via
  Node's `AsyncLocalStorage` (available on Workers via
  `nodejs_compat`) instead of a module-level mutable variable —
  concurrent requests in the same warm isolate no longer share
  statements. OAuth authorization-code consumption is now a single
  atomic `UPDATE … RETURNING`, so a race on the token endpoint can no
  longer mint two tokens for one code. The magic-link verify POST
  handler no longer double-acquires the runtime mutation lock.
- **Security headers**: real browser-facing CSP on every HTML response
  (with a stricter profile for public publications under `/p/*` and
  `/f/*`), plus `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy:
same-origin`, and an extended Permissions-Policy. HSTS unchanged.
- **Routing**: every app page lives under `/app/*`; root-level
  `/login`, `/signup`, `/setup`, `/profile`, `/admin` removed.
- **Adapter split**: Node-only code moved to `apps/web/src/adapters/node/`
  and dynamically imported behind `isNodeRuntime()`, so the
  Cloudflare bundle no longer ships `node:fs`/`node:path`/`better-sqlite3`.
- **Cleanup**: removed dead two-Worker-split scaffolding (`backend/`,
  `api-client.ts`, `target.ts`, two example wranglers), custom shell
  controller, document-payload partial endpoints, `ServiceError`,
  `attachEnvelope`, `SessionHandle`, Drizzle schema package surface,
  and the unused `codemirror` and `tslib` deps.
- **Production hygiene**: added `/api/health` liveness endpoint,
  `public/robots.txt`, custom branded `404.astro`, dropped a
  developer-specific tunnel domain from `astro.config.mjs`.
