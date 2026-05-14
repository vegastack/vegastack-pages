# Core Implementation Conventions

Status: Draft  
Date: 2026-05-10

## Purpose

This spec removes ambiguity that would otherwise slow down implementation in a fresh session.

## ID Conventions

Use opaque, URL-safe IDs.

Recommended prefixes:

- `usr_` user
- `aid_` auth identity
- `wks_` workspace
- `fld_` folder
- `pg_` page
- `ver_` page version
- `att_` attachment
- `thr_` comment thread
- `rpl_` comment reply
- `pub_` publication
- `agt_` agent session
- `ses_` auth/session
- `job_` background job
- `aud_` audit log

IDs must be unique across the instance. Use UUIDv7, ULID, or another time-sortable secure random ID. Do not use sequential integers in public URLs.

## Page Slug IDs

Public route:

```text
/p/{page-title-slug}-{short-id}
```

Rules:

- Title part is generated from current title.
- `short-id` is derived from page ID or a unique random suffix.
- Suffix must be globally unique across the instance.
- Route lookup uses suffix first, not title text.
- If title changes, old slugs should redirect to the current slug where practical.
- If redirect tracking is not implemented in MVP, old clean title slugs may 404 but the page ID suffix remains canonical.

Example:

```text
/p/api-review-a8f31c
```

## Time And Ordering

- Store timestamps as ISO strings or integer milliseconds consistently through Drizzle.
- Prefer UTC everywhere.
- Use sortable `position` numbers for manual tree ordering.
- Initial positions can increment by `1000` to allow inserts between items.

## Source Type Enum

Allowed source types:

- `markdown`
- `mdx`
- `html`

Reject all other values.

File extension mapping:

- `markdown` -> `.md`
- `mdx` -> `.mdx`
- `html` -> `.html`

## Permission Resolution Algorithm

Effective permission is resolved in this order:

1. Instance admin receives admin access.
2. Workspace membership role establishes baseline access.
3. Folder permissions are applied from root to nearest parent.
4. Page explicit permission overrides inherited folder permission.
5. Public publication applies only for unauthenticated or guest access to the linked page.
6. Deny wins when an explicit `none` override is set at a closer scope.

Permission comparison order:

```text
none < read < comment < write < admin
```

Required permissions:

- View rendered page: `read`.
- View comments: `read`.
- Create comment/reply: `comment`.
- Resolve own comment: `comment`.
- Resolve any comment: `write`.
- Edit source: `write`.
- Upload attachment: `write`.
- Create publication: `admin`.
- Change permissions: `admin`.

## Public Share Grant Rules

Public grant types:

- `view` maps to `read`.
- `comment` maps to `comment`.
- `edit` maps to `write`.

Rules:

- Public grant never gives `admin`.
- Public grant never gives workspace tree access.
- Public grant never gives sibling page access.
- Password, expiry, and revocation are checked before permission mapping.
- Guest display name is required before `comment` or `edit`.

## Version Checkpoint Policy

Autosave does not create retained versions on every keystroke.

Recommended MVP policy:

- Current source is updated on autosave.
- Create a checkpoint if the last checkpoint is older than 10 minutes and source changed.
- Create a checkpoint when a page is shared for the first time.
- Create a checkpoint when the user triggers manual snapshot.
- Create a checkpoint before applying large agent-suggested changes if exposed later.
- Keep checkpoints for 30 days by default.

Version metadata:

- `version_id`
- `page_id`
- `object_key`
- `source_hash`
- `source_type`
- `label`
- `created_by`
- `created_reason`: `manual`, `time_checkpoint`, `share_milestone`, `system`
- `created_at`

## Conflict Handling

Every source edit request includes:

- `base_version_id` or `etag`.
- New source body.

If current version differs:

- Return `CONFLICT`.
- Include latest version ID, latest updated timestamp, and latest updater display name.
- Do not overwrite silently.

MVP resolution:

- User can overwrite explicitly after seeing conflict.
- Automatic three-way merge can be later.

## Comment Anchor Algorithm

Store multiple anchor strategies:

1. Source offsets.
2. Selected text.
3. Prefix/suffix context.
4. Rendered DOM path.
5. Content hash at creation.

Re-anchor order:

1. If content hash matches, use stored DOM path or offsets.
2. If source offsets still match selected text, use offsets.
3. Search for exact selected text near previous offset.
4. Search for selected text plus prefix/suffix.
5. Mark anchor as stale and show thread as unanchored but still visible in sidebar.

Anchor statuses:

- `active`
- `reanchored`
- `stale`

Never delete a comment because its anchor went stale.

## Render Cache Key

Render cache key must include:

- Page ID.
- Source content hash.
- Source type.
- Renderer version.
- MDX component policy version.
- Sanitizer policy version.

Any change to renderer/sanitizer/component policy invalidates cache.

## Search Indexing

Index only sanitized/plain text extracted from the source/rendered result.

Index fields:

- Title.
- Path.
- Headings.
- Frontmatter flattened text.
- Body text.
- Tags.

Do not index:

- Private comments in page search unless a dedicated comments search is added later.
- Raw secrets from config.
- Raw public publications.

## Event Names

Use consistent event names across API, CLI, MCP, and internal event bus:

- `page.created`
- `page.updated`
- `page.deleted`
- `page.version_created`
- `comment.created`
- `comment.replied`
- `comment.resolved`
- `comment.unresolved`
- `publication.created`
- `publication.revoked`
- `review.condition_met`

Event payload minimum:

```json
{
  "event": "comment.created",
  "id": "evt_...",
  "workspace_id": "wks_...",
  "page_id": "pg_...",
  "actor": {
    "type": "user",
    "id": "usr_...",
    "display_name": "Mira"
  },
  "created_at": "2026-05-10T00:00:00.000Z",
  "data": {}
}
```

## Audit Event Names

Use dot-separated action names:

- `instance.setup_completed`
- `workspace.created`
- `user.invited`
- `user.removed`
- `permission.updated`
- `publication.created`
- `publication.updated`
- `publication.revoked`
- `auth.google_configured`
- `retention.updated`
- `mcp.session_created`
- `agent.reply_created`

## Object Key Move Policy

R2/S3 object paths mirror folders for backup usability, but object moves are not required synchronously.

MVP rule:

- On rename or move, update DB path immediately.
- New writes go to the new object path.
- Old version objects can remain at old paths.
- Workspace export uses DB metadata to produce a clean ZIP structure, regardless of physical object key history.

## Default Limits

Initial defaults:

- Page source size: 1 MiB.
- Attachment size: 10 MiB.
- Comment body: 10,000 characters.
- Public link password minimum: 8 characters.
- Setup token TTL: 30 minutes.
- Session TTL: 30 days.
- Version retention: 30 days.

All limits should be configurable in hosting config or workspace settings where appropriate.
