---
title: Public links
description: Publish a page or folder outside the workspace with view, comment, or edit access.
category: Sharing
order: 10
lastUpdated: 2026-05-14
---

Public publishing is the way you bring a reviewer or reader in without giving them a workspace seat.

## The share dialog

Open a page or folder and click **Share** in the header, then choose the **Publish** tab. It has four controls:

- **Permission**: View, Comment, or Edit. Default is View.
- **Expires**: Never, 1 day, 7 days, 30 days, or a custom date. Default is Never.
- **Password**: Optional. When set, the visitor enters it before the page renders.
- **Search indexing**: Off by default. Public pages and folders are `noindex` unless you flip this.

Click **Publish** to create and copy the URL. Pages use `/p/page-title-id`; folders use `/f/folder-title-id`. There is no hidden URL token.

## Scope

A page publication grants access to that page only. A folder publication grants access to that folder subtree only, with a simplified sidebar showing published child folders and pages. Private siblings and workspace settings are never exposed.

## Editing as a guest

If the link grants edit, the visitor enters a display name once, then has full source-mode access to that page. Their edits create regular checkpoints. The display name attaches to every comment and edit they make so agents can attribute changes back to them.

## Revoking

Open the same **Share** dialog and choose **Unpublish**. Revoked or expired publications stop page rendering, comments, edits, and public search.

## Agent use

Agents can create and revoke publications through MCP and CLI:

```js
await mcp.call("publish_page", {
  workspace_id: "wks_123",
  page_id: "pg_123",
  permission: "comment",
  indexing_enabled: false,
});
```

```sh
vpg --workspace wks_123 publish-page pg_123 --permission comment
vpg --workspace wks_123 revoke-publication pub_123
```
