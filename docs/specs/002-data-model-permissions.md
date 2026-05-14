# Data Model And Permissions Specification

Status: Draft  
Date: 2026-05-10

## Database Choice

Use Drizzle ORM.

Cloudflare mode:

- Cloudflare D1.
- SQLite FTS5 for permission-aware search.

Node mode:

- SQLite initially.
- Postgres may be added later.

## Core Entities

Suggested tables:

- `instances`
- `users`
- `auth_identities`
- `workspaces`
- `workspace_members`
- `folders`
- `pages`
- `page_versions`
- `attachments`
- `comments`
- `comment_replies`
- `comment_anchors`
- `permissions`
- `publications`
- `agent_sessions`
- `mcp_sessions`
- `search_documents`
- `audit_logs`
- `jobs`

## Tenancy

One deployed instance can host many workspaces.

Every workspace-owned row must include `workspace_id`.

Global page links use page IDs that are unique across the instance:

```text
/p/page-title-abc123
```

Lookup flow:

1. Parse `abc123`.
2. Load page by globally unique page ID.
3. Load page workspace.
4. Resolve authenticated user membership or public publication.
5. Return content only if allowed.

## Users

Users:

- Email required.
- Name optional for invited users but should be requested.
- Created through setup, invite, or managed-hosting signup.
- Self-hosted instances default to no public signup.

Auth identities:

- Email magic link.
- Google OAuth optional.

Guest users:

- Not full user accounts.
- Must provide display name before comment/edit through public link.
- Activity is attached to guest session and publication.

## Pages And Folders

Everything in the visible tree is called a page, but folders can organize pages.

Folder fields:

- `id`
- `workspace_id`
- `parent_folder_id`
- `name`
- `slug`
- `path`
- `position`
- `created_by`
- `created_at`
- `updated_at`

Page fields:

- `id`
- `workspace_id`
- `folder_id`
- `title`
- `slug`
- `slug_id`
- `source_type`: `markdown`, `mdx`, `html`
- `object_key_current`
- `frontmatter_json`
- `content_hash`
- `render_cache_key`
- `position`
- `created_by`
- `updated_by`
- `created_at`
- `updated_at`
- `deleted_at`

Ordering:

- Manual drag/drop stores `position`.
- Fallback sort is position, then title.
- Folder order and page order share the same tree UI.

## Object Storage

Object keys mirror folder hierarchy where practical.

Current source:

```text
workspaces/{workspace}/pages/{folder-path}/{page-slug}-{id}/source/current.md
```

Versions:

```text
workspaces/{workspace}/pages/{folder-path}/{page-slug}-{id}/versions/{timestamp}-{versionId}.md
```

Attachments:

```text
workspaces/{workspace}/pages/{folder-path}/{page-slug}-{id}/attachments/{attachmentId}/{filename}
```

Render cache:

```text
workspaces/{workspace}/pages/{folder-path}/{page-slug}-{id}/render-cache/{contentHash}.html
```

If a page is moved or renamed, the app may keep old object keys and update metadata, or schedule a background object move. Correctness matters more than object path prettiness.

## Versioning

Versions are durable checkpoints.

Triggers:

- Manual snapshot.
- Publish/share milestone.
- Time-window checkpoint after autosaves.
- Significant source change threshold.

Retention:

- Default 30 days.
- Configurable at instance/workspace level.
- Cleanup job removes old version objects and metadata.

Do not write a full R2/S3 object on every keystroke as a retained version.

## Permissions

Permission levels:

- `none`
- `read`
- `comment`
- `write`
- `admin`

Scopes:

- Instance
- Workspace
- Folder
- Page
- Publication

Inheritance:

- Folder permissions inherit to child folders and pages unless overridden.
- Page explicit permission wins over inherited folder permission.
- Public publications apply only to the linked page.

Rules:

- `read`: can view rendered content and attachments.
- `comment`: can read and create/reply to comments.
- `write`: can edit source, upload attachments, create versions.
- `admin`: can manage permissions and publications.

## Share Links

Fields:

- `id`
- `page_id`
- `workspace_id`
- `token_hash`
- `permission`: `view`, `comment`, `edit`
- `expires_at`
- `password_hash`
- `indexing_enabled`
- `created_by`
- `revoked_at`

Defaults:

- Permission: view.
- Expiry: none.
- Password: none.
- Indexing: false.

Public link tokens must not be stored in plaintext.

## Comments

Thread fields:

- `id`
- `page_id`
- `workspace_id`
- `status`: `open`, `resolved`
- `selected_text`
- `created_by_user_id`
- `guest_name`
- `created_at`
- `resolved_by`
- `resolved_at`

Anchor fields:

- `thread_id`
- `source_start`
- `source_end`
- `rendered_dom_path`
- `selected_text`
- `prefix_text`
- `suffix_text`
- `content_hash_at_creation`
- `reanchor_status`

Reply fields:

- `id`
- `thread_id`
- `body`
- `author_type`: `user`, `guest`, `agent`
- `agent_name`
- `agent_model`
- `agent_session_id`
- `created_at`

## Search

Search document fields:

- `page_id`
- `workspace_id`
- `title`
- `path`
- `headings_text`
- `frontmatter_text`
- `body_text`
- `tags`
- `updated_at`

Search queries must join against effective permissions before returning results.

## Audit Logs

Audit v1 covers admin-sensitive actions:

- Instance setup.
- Workspace creation/deletion.
- User invite/removal.
- Permission changes.
- Publication create/update/revoke.
- OAuth provider changes.
- Retention changes.
- MCP login/session creation.
- Agent replies if needed for traceability.

Audit fields:

- `actor_user_id`
- `workspace_id`
- `action`
- `target_type`
- `target_id`
- `metadata_json`
- `created_at`
