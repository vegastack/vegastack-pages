---
"@vegastack/pages": minor
---

Workspace + per-user datetime preferences, page-header Move/Trash,
inline page-title editing, trash UI polish, datetime sweep across
every timestamp surface.

**Datetime preferences (new feature)**

- Two new schema columns (`workspaces.preferences_json`,
  `users.preferences_json`) via migration `0004_datetime_preferences.sql` —
  additive ALTER with `NOT NULL DEFAULT '{}'` so existing rows stay
  well-formed.
- Pure `formatDateTime()` + `formatAbsolute()` + `readDateTimePrefs()` +
  `mergeDateTimePrefs()` in `@vegastack/pages-core`, with an LRU cache
  on `Intl.DateTimeFormat` instances (limit 64) so dozens of
  timestamps per page cost ~10 ns/lookup instead of ~5 ms/construct.
  14 unit tests cover invalid-blob handling, merge fallthrough,
  absolute + relative + date-only rendering.
- `PATCH /api/workspaces/:id/preferences` (admin) + `PATCH
/api/me/preferences` (signed-in user). Partial-merge into the
  JSON blob, validated against the typed shape — invalid keys
  return `VALIDATION_ERROR`.
- `DateTimePreferencesCard` on Settings → General (workspace
  default, admin-only edit) and Settings → Profile (per-user
  override, always editable for the signed-in user). Uses the same
  `.settings-card` / `.settings-card-form` / `.vpg-field` /
  `.vpg-input` / `.vpg-button vpg-button-primary` shell as Version
  retention + Backup to Git — no bespoke styling. Live preview
  block updates as the admin changes any knob. The card sits
  immediately below Version retention in the General page reading
  order.
- Three knobs (per the feature interview):
  - `dateFormat`: 5 named presets, default `MMM D, YYYY`.
  - `timeFormat`: 12h or 24h, default 24h.
  - `showRelativeWithinDays`: 7-day relative window toggle.
- Backend stays UTC ISO; the client-side
  `apps/web/src/scripts/time-format.ts` walks every `<time datetime>`
  on page-load + after each Astro view-transition and rewrites the
  visible text in the viewer's browser timezone using the effective
  prefs from `<meta name="vpg-datetime-prefs">`. MutationObserver
  catches React-injected nodes; a 60s ticker keeps relative
  entries fresh; a `vpg:time-refresh` event lets surfaces request
  an immediate re-walk when they mutate a `<time>` element in place.

**Datetime sweep — every timestamp surface conforms**

- `<time datetime>` wrappers added: audit log, profile Created,
  connections session list (3 cols), workspace connections log
  cards (3 dl rows), attachments, DocsLayout "Last updated",
  PageHeader "Edited X ago", CommentsPanel reply timestamps,
  /p/ Created at / Updated at metadata.
- `CommentsPanel` bespoke relative-time helpers replaced with
  central `formatDateTime` / `formatAbsolute` (was duplicating
  locale logic).
- PageHeader's hand-rolled `relativeEdit` JS dropped; the central
  rewriter handles the label, refresh-on-save just updates the
  `datetime` attribute + dispatches `vpg:time-refresh`.

**Page-header kebab — Move + Trash**

- `PageActionsMenu` (the top-right `…` next to Share / Favorite)
  gains `Move page` and `Move to trash` items for editors. Same
  modal + undo-toast flow as the sidebar kebab.
- Folder list threaded from `PageHeader.astro` → page-actions
  controller → `PageActionsMenu` via a JSON data attribute so the
  Move dialog renders without a separate fetch.
- Cross-page undo handoff: when the user trashes the page they're
  currently viewing, the toast intent persists in `sessionStorage`
  and re-fires on the destination workspace page so the 10-second
  undo window survives the hard navigation.

**Inline page title editing**

- The `<h1>` on `/p/{slug}` is now `contenteditable="plaintext-only"`
  for users with edit permission. Click to edit, Enter / blur
  commits, Esc cancels. Optimistic UI — title updates locally
  first; server save runs in background; on failure the original
  text is restored and an error toast surfaces.
- New slug is written back via `history.replaceState` so
  deep-links update without a full navigation. Other surfaces
  resync via a fresh `vpg:page-title-changed` custom event.

**Trash UI polish**

- `/app/trash` moved out of SettingsLayout. Now lives in the
  workspace AppLayout shell so the regular workspace sidebar
  (pages tree) stays visible — it's a peer of workspace pages,
  not an admin nook. Page header reuses `.settings-pageheader`
  styling for visual consistency, without the eyebrow.
- Move + Trash kebab items render with default menu-item styling
  (no red text / no red hover background). "Move to…" relabeled
  "Move page". Aligns with the rest of the dropdown.
- `MoveToFolderDialog` + `TrashList` + `PermanentDeleteConfirm`
  rebuilt with Nova UI primitives (`Dialog`, `Input`, `Button` +
  Lucide icons) so they read as siblings of `ShareDialog`.

**CSP fix — Astro ClientRouter prep iframe**

- `frame-ancestors` relaxed from `'none'` to `'self'` on HTML
  responses. Astro's view-transition prep step mounts a hidden
  same-origin iframe to hydrate `client:only` islands before the
  swap; the stricter policy was silently aborting that step in
  dev, breaking sidebar URL updates after navigation. `'self'`
  still blocks every third-party embed.
