---
title: Permissions
description: Roles at the instance, workspace, folder, and page level, and how they compose.
category: Sharing
order: 20
lastUpdated: 2026-05-13
---

Permissions are checked server-side on every read, write, search, export, attachment, comment, and MCP call. There is no permission state that lives only on the client.

## Levels

- **No access**: the user does not see the page in search and cannot open it.
- **Read**: render the page.
- **Comment**: render plus inline threads.
- **Read-write**: render, comment, and edit source.
- **Admin or manage**: manage settings at the scope it applies to.

## Scopes

Permissions apply at four scopes: instance, workspace, folder, and page. Folder permissions inherit downward unless explicitly overridden on a child folder or page.

Workspace roles are managed in **Settings > Members**. Folder and page access is managed from the **Share** button on the folder or page itself.

## Sharing surfaces

- **Share page**: manage member access for that page or publish it at its canonical `/p/...` URL.
- **Share folder**: manage member access for the folder and pages inside it or publish the folder subtree at `/f/...`.
- **Publications**: grant public access without making the visitor a workspace member. Folder publications show a simplified sidebar scoped to that subtree.

## Roles

- **Instance admin**: created during first setup. Manages instance settings, workspaces, OAuth, retention, and admin audit views.
- **Workspace admin**: manages users, folders, page/folder access, publications, and workspace settings.
- **Editor / Commenter / Reader**: standard content roles inside a workspace.
- **Guest reviewer**: a user who arrived through a public link. Scoped to that page.
- **MCP session**: a workspace-scoped bearer token created by an authenticated workspace admin for an agent client. Tokens are shown once and can be revoked.

## Search

`Cmd+K` search is permission-aware. The server filters results before returning them. The client never sees a title or snippet for a page it cannot open.
