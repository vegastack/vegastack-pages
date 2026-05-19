---
title: Pages and folders
description: How the content tree, page IDs, and folder permissions work.
category: Pages
order: 10
lastUpdated: 2026-05-20
---

The left sidebar in the app is a tree of folders and pages. Folders are containers. Pages are documents.

## Page identity

Every page has a globally unique ID. The display URL is `/p/page-title-id` where the suffix is unique across all workspaces. Folders use `/f/folder-title-id`. Lookup resolves by ID, then enforces member access or publication permissions.

This means a user with access to multiple workspaces can open any accessible page without workspace path prefixes. It also means a page ID never collides across tenants.

## Source types

A page can be one of:

- Markdown
- GitHub Flavored Markdown
- MDX
- Raw HTML

MDX stays source-first to preserve agent-authored content safely. HTML pages require explicit source mode to edit.

## Folders

Folders inherit permissions downward unless explicitly overridden. The content tree is organizational only; page IDs are flat under the hood. Move a page between folders and its URL stays the same.

Use **Share folder** to give a workspace member View, Comment, Edit, or No access for that folder. The rule applies to pages inside the folder unless a page has its own member access rule.

## Attachments

Pages can carry attachments: images, SVGs, and other files referenced in content. Attachments are stored in object storage and served through permission-checked URLs. SVG uploads are sanitized or served with safe headers.

## Favorites and search

Users can favorite pages. Favorites are stored server-side and appear in the sidebar. Search covers pages, folders, and comment threads, then filters every result against the caller's permissions before returning it.

## Exports and Git backup

Workspace exports and Backup to Git both preserve source-first content. Backup to Git also includes templates and optional assets when configured.

## Agent surface

The full content tree is reachable through MCP `fetch` (with workspace-level `include=["tree"]`) and the CLI's noun-first groups:

```sh
vpg workspaces tree
vpg pages get plan-abc123 --include source,edit_tokens,comments,publication
vpg pages move pg_123 --folder-path /design/2026
vpg pages versions pg_123
vpg pages restore pg_123 ver_old
vpg pages create --template prd --title "Plan" --set owner=platform
vpg attachments upload pg_123 --filename diagram.png --content-type image/png --base64-file ./diagram.b64

# --agent mode:
vpg --agent pages get pg_123 --include source,edit_tokens
vpg --agent workspaces tree
```

From MCP:

```js
await mcp.call("fetch", {
  workspace_id: "wks_123",
  resource_id: "wks_123",
  include: ["tree"],
  depth: 3,
});

await mcp.call("move_page", {
  workspace_id: "wks_123",
  page_id: "pg_123",
  folder_path: "/design/2026",
});
```

See [MCP and CLI](/docs/mcp-and-cli) for the full tool reference.
