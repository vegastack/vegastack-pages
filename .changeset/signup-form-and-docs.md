---
"@vegastack/pages": patch
---

Production-readiness follow-ups discovered while validating the
v0.1.14-next.1 deploy:

- **Signup + login form hardening.** Both `/app/signup` and `/app/login`
  forms now declare `method="post"`, an explicit `action` pointing at
  the real API endpoint, and an inline `onsubmit="event.preventDefault()"`.
  Pre-hydration the browser no longer falls through to the default GET
  submission that leaked form fields into the URL query string.
- **`vpg signup` rate limit relaxed** to 1 request per 60s per email
  (was 4 per 30 minutes). Sane for legitimate retry-after-typo, still
  tight enough to deter abuse.
- **Email sender pinned to `pages@vegastack.com`** in `wrangler.jsonc`
  (both `VPG_EMAIL_FROM` and the `send_email` binding allowlist) and the
  generated `worker-configuration.d.ts`. Matches the live dashboard
  override and keeps source in sync with prod.
- **Customer-facing docs cross-links fixed** in `mcp-and-cli.md`,
  `quickstart.md`, and `pages-and-folders.md`. Bare `target.md` relative
  paths were resolving as `/docs/<current>/<target>.md` instead of
  `/docs/<target>`. Switched all 9 links to absolute `/docs/<slug>` form.
- Operator runbook §1.4 now lists `pages@vegastack.com` as the verified
  sender + the matching `cf-bounce.vegastack.com` DKIM record.
