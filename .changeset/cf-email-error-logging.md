---
"@vegastack/pages": patch
---

Surface Cloudflare `send_email` binding failures as structured log
events instead of silently swallowing them. Until now, when SES fell
back to Cloudflare and Cloudflare also rejected the send (e.g.,
destination not verified, sender not on the allowlist), the only
operator-visible signal was a generic 500 from `/api/auth/signup`. Both
binding code paths now emit `vpg.email.cloudflare.*_failed` events with
the upstream error message.
