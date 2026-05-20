---
"@vegastack/pages": patch
---

Two audit fix-ups on top of the v0.2.0-next.11 trash backend ship:

- **`pages.hardDelete` drops orphan publications rows.**
  `publications.resource_id` is a plain TEXT column with no FK to
  `pages.id`, so hard-deleting a page would otherwise leave a
  publications row pointing at a missing page. The fix-up also
  collects each publication's `latest_artifact_key` into the same
  R2-cleanup pass we already do for the page source + rendered
  artifact + every page_versions object key.
- **Cron auto-purge writes an audit row per purged page.** When the
  nightly `0 4 * * *` job hard-deletes a soft-deleted page that
  passed its 30-day TTL, we now emit an `audit_log` entry with
  `action: page.hard_deleted`, `actorUserId: null`, and metadata
  recording `source: cron-auto-purge`, `ttl_days`, the original
  `deleted_at`, and `deleted_by_user_id`. Admins answering "what
  disappeared overnight?" can trace each purge back to both the
  cron and the original trash event.
