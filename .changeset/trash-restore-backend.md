---
"@vegastack/pages": minor
---

Page trash + restore backend, with auto-purge cron, MCP/CLI tools,
and generic 404 for soft-deleted publication URLs. UI surfaces
(sidebar kebab, undo toast, sidebar Trash link, Workspace Settings
→ Recovery, inline title editing, move-to modal, drag-and-drop)
are deferred to the follow-up release.

- **Schema.** `pages.deleted_by_user_id` column (FK → users.id ON
  DELETE SET NULL) so the Workspace Recovery surface can display
  who trashed a given page.
- **Service layer.** `pages.softDelete` now records the actor id;
  new `pages.hardDelete` drops the D1 row + page_versions cascade
  - R2 source + rendered artifact; new `pages.listTrashed` returns
    trashed pages scoped to "mine" or "workspace"; new
    `pages.listExpiredTrashedIds` powers the auto-purge cron. Both
    `pages.get` and `pages.getBySlugId` now accept
    `{ includeDeleted: true }`.
- **HTTP API.** `POST /api/pages/:id/trash` (editor+ soft-delete) +
  `DELETE /api/pages/:id/trash` (admin hard-delete); `POST
/api/pages/:id/restore` (editor+); `GET
/api/workspaces/:id/trash?scope=mine|workspace` with deleted-by
  user hydration in the workspace scope.
- **Publication route.** `/p/{slug}` returns a generic 404 for
  anonymous visitors when the underlying page is soft-deleted (no
  leak that the slug ever existed — matches Google Drive's
  "Sorry, the file you have requested does not exist"). Logged-in
  workspace editors get a friendly "This page is in the trash"
  banner with a one-click Restore button.
- **Cron.** New `0 4 * * *` daily Worker cron runs
  `runTrashAutoPurge`, hard-deleting pages whose `deleted_at` is
  older than 30 days. Dispatches by cron expression so the existing
  GitHub-backup + search-reconciler jobs aren't disturbed.
- **MCP tools.** `delete_page` (with `permanent: boolean` flag),
  `restore_page`, `list_trash` (with `scope` filter). Total tool
  surface bumps from 19 → 22. Tool descriptions document the
  semantics explicitly.
- **CLI.** `vpg pages delete <page> [--permanent]`, `vpg pages
undelete <page>` (avoids name clash with the existing
  `vpg pages restore <page> <version-id>` for version restores),
  `vpg pages trash [--scope mine|workspace]`.
- **Permissions.** Editors+ can soft-delete and restore; admins
  only can hard-delete (permanent). Mirrors the user choice in the
  feature interview.

UI deferred to v0.1.15 (or the next prerelease, depending on the
timing of the next ship). Until then, admins can manage the trash
from CLI/MCP; users see soft-deleted pages disappear naturally
from the sidebar and search.
