---
"@vegastack/pages": minor
---

Clean-slate rebuild of the data layer and frontend architecture for production launch.

- Removed the legacy in-memory snapshot + global mutation lock + per-mutation runtime persistence pattern. Services now write directly to D1 with per-request scope.
- Squashed 21 migrations into a single `0001_init.sql` plus a small `0002_oauth_seed.sql`.
- Adopted Astro 6 + `@astrojs/cloudflare` v13 canonical patterns: `cloudflare:workers` env import, generated `Env` types, Smart Placement, `transition:persist` on persistent islands, server-side Actions for browser mutations.
- Consolidated to one error class (`AppError`), one envelope helper (`jsonWithEnvelope`), one runtime discriminator (`VPG_RUNTIME`), one canonical permission helper, one URL prefix for the app (`/app/*`).
- Replaced the custom shell controller with native Astro `<ClientRouter />` + persistent islands.
- Cached public-publication HTML via Workers Cache API (`caches.default`) keyed by content hash.
- Switched magic-link delivery to Resend HTTPS API and dropped the unused `send_email` and `SESSION` KV bindings.
- Added per-page renderer flags so heavy libs (Mermaid, KaTeX, Cytoscape, Wardley, Shiki) are loaded only on pages that use them.
- Added security headers middleware, rate-limiting binding, full observability with Sentry via OTLP.
- Split Node-only adapter code into `apps/web/src/adapters/node/` so the Cloudflare bundle never imports `node:*`.
