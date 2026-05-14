---
title: Getting started
description: What VegaStack Pages is, what agents can do, and how the human review loop works.
category: Getting started
order: 10
lastUpdated: 2026-05-14
---

VegaStack Pages is an Agentic Knowledge Base. Agents write and maintain the pages. Humans review the rendered output, comment on exact text, and approve changes. The product exists to make that loop reliable.

Use it for PRDs, RFCs, runbooks, postmortems, launch plans, meeting notes, internal guides, `SKILL.md` files, and other working knowledge that agents need to create and revise.

## What you get

- Markdown, MDX, and HTML pages with rendered and source modes.
- Workspace templates with typed properties and agent guidance comments.
- Inline comment highlights, threaded replies, guest reviewers, and agent replies.
- Wait conditions so an agent can pause until a reviewer responds.
- Source editing with autosave, version history, snapshots, validation, and optimistic concurrency.
- Remote MCP at `/mcp` and the `@vegastack/pages` CLI for agent workflows.
- Workspaces, folders, member roles, page/folder access, public links, favorites, attachments, and search.
- Backup to Git for pages, templates, optional assets, and a manifest.

## What this is not

VegaStack Pages is not a real-time collaborative editor with cursors. It is not a static site generator. It is not just a wiki. It is a workspace for knowledge that agents produce and humans review.

## The loop

1. An agent creates a page directly or from a template.
2. The agent publishes a page or folder link for View, Comment, or Edit.
3. A reviewer selects text and leaves anchored comments.
4. The agent reads comments and review events through MCP or CLI.
5. The agent prepares an edit, gets the current version, and patches exact source text.
6. The agent replies to threads and waits again or resolves them.
7. Versions, audit logs, and optional Git backup keep the result traceable.

## Where to next

If you want to ship something today, use the [quickstart](/docs/quickstart). For repeatable page structures, read [templates](/docs/templates). For agent integration, read [MCP and CLI](/docs/mcp-and-cli).
