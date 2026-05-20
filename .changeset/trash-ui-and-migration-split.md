---
"@vegastack/pages": minor
---

Trash UI surfaces + the schema-migration split that recovered prod.

**Schema migration (urgent fix).** `pages.deleted_by_user_id` was
inlined into `0001_init.sql` on next.11. Prod's D1 had been created
from an older 0001 so the new code's SELECTs failed with
`no such column` — every authed page rendered as a 500. Fixed by
moving the column out of 0001 and into a delta migration
`0003_pages_deleted_by.sql`. Prod was patched in place with a
manual ALTER on 2026-05-20; fresh self-hosted installs apply the
delta as part of the migration sweep.

**Sidebar page-row kebab (`PageRowMenu`).** Each page row in the
workspace sidebar now exposes a `…` menu on hover/focus with
"Move to…", "Copy link", and "Move to trash". The kebab is hidden
for read-only members.

**Move-to-folder modal (`MoveToFolderDialog`).** Type-ahead search
over a flattened folder list (paths shown). "/ (root)" is always
the first row. Calls `POST /api/pages/:id/move` and full-reloads
to resync the sidebar tree at the new location.

**Undo toast on soft-delete.** sonner toast with 10-second window;
clicking Undo calls `POST /api/pages/:id/restore`. If you trash the
page you're currently on, you're bounced to the workspace root so
you don't sit on a now-soft-deleted document.

**Sidebar "Trash" link + `/app/trash` page.** New "Trash" entry in
the workspace sidebar footer (above Settings). Routes to a
SettingsLayout-hosted page listing the pages **the current user**
trashed. Restore per row. Empty state when there's nothing trashed.
Timestamps render via `toLocaleString()` in the viewer's browser
timezone.

**Workspace Settings → Recovery (`/app/settings/recovery`).** All
soft-deleted pages workspace-wide, with deleted-by user hydration.
Editors+ can restore; only admins see the "Delete forever" button.
The SettingsSidebar grows a `Recovery` nav entry for editors+.

**Permanent-delete type-to-confirm modal.** Shared across the user
trash + Workspace Recovery surfaces. Users must type the page
title verbatim to enable the destructive button — matches GitHub's
repo-delete pattern.

**Publication route "in trash" banner CSRF fix.** The restore
button on `/p/{slug}` used a plain `<form method="post">`; the
middleware CSRF gate would have blocked the POST because HTML
form submissions don't carry the `x-vpg-csrf-token` header. The
banner now uses a `data-vpg-trash-restore` button with an inline
script that calls `window.fetch` — the AppLayout fetch interceptor
attaches the CSRF header automatically.

**CSS additions (`shell.css`).** Kebab popover, hover-to-reveal row
action affordance, modal shell, folder picker tree, button
variants, danger styling. Defense-in-depth sizing rules co-locate
with the sidebar styles.

**Deferred to a follow-up release** (will land in the next
prerelease):

- Page-header (top-right) kebab — adding "Move to…" + "Move to
  trash" + "Restore" entries to the existing `PageActionsMenu`.
  Sidebar kebab covers the main use case today.
- Inline page-title editing (click the page H1 → editable). Hooks
  cleanly into the existing `.prose-title` element + page-editor
  controller; deserves dedicated UX care (slug regeneration,
  optimistic UI, conflict handling).
- Drag-and-drop sidebar reorder + cross-folder move. Needs the
  `@dnd-kit` wiring and careful hit-target choices (reorder within
  the same folder vs drop-on-folder).
- Workspace + per-user datetime preferences. The trash list
  already renders timestamps via `toLocaleString()` as a stopgap;
  the full picker needs a schema column (`preferences_json` on
  both `workspaces` and `users`), a `PATCH /api/.../preferences`
  endpoint pair, a `formatDateTime()` helper in
  `@vegastack/pages-core`, two settings UI surfaces, and a tiny
  client script that rewrites every `<time datetime="…">` element
  in the viewer's browser timezone. Backend stays UTC.
