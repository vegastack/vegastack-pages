---
"@vegastack/pages": patch
---

Unify the HTML Content-Security-Policy profile across the app shell and
public publication routes (`/p/*`, `/f/*`). Previously, publications
used a strict `script-src 'self'` while the app shell used
`script-src 'self' 'unsafe-inline'`. The strict branch was wrong in
practice: publications still render `AppLayout`, which emits Astro
view-transition + theme-detect + CSRF-wrapper inline scripts, and a
ClientRouter navigation from `/p/...` into `/app/*` carries the
originating document's CSP into the swapped-in DOM — breaking
dropdowns, the command palette, and settings modals on the destination
route. Both routes now share the permissive profile and whitelist the
Cloudflare Web Analytics beacon host (`static.cloudflareinsights.com`)
on `script-src` + `connect-src`. Also widens `form-action` from
`'self'` to `'self' https:` so OAuth authorize/consent flows can
redirect to third-party MCP clients (claude.ai, cursor.sh, etc.) —
Chrome enforces `form-action` across the full redirect chain, so the
narrower policy was silently killing the "Allow Claude" button. CLI
device-flow login is unaffected (no browser form involved). The
signup rate limit also moves from 1/min to 10/min to match real-world
burst behavior during onboarding.
