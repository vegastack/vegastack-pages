---
title: Rendered and source modes
description: When to use rendered mode, when to drop into source, and what changes between them.
category: Pages
order: 20
lastUpdated: 2026-05-11
---

Each page opens rendered. Click Edit to unlock the document into source-backed editing.

## Rendered mode

Rendered mode is the default when opening a page. It shows:

- Page title and metadata table from frontmatter.
- The rendered document body in a modern serif.
- Inline comment highlights for unresolved threads.
- A right sidebar with threads.
- A table of contents for h2 and h3.
- Copy buttons on code blocks.

Click a highlight to focus the thread. Resolved comments are hidden by default and can be revealed from the threads panel.

## Source edit mode

Source mode uses CodeMirror 6 with a Markdown, MDX, or HTML language mode depending on the page type. Markdown and MDX use Obsidian-style preview: headings, links, lists, quotes, tasks, and code blocks keep their rendered shape, while raw Markdown marks appear on the active line or selected range.

- Autosave updates the draft and the current source.
- Conflict warnings appear if the source version changed elsewhere.
- Checkpoint versions are created on a time-window cadence, on share milestones, on manual named snapshots, and on major changes. Default retention is 30 days, configurable per workspace.

## Why source-backed editing

The editor does not convert rendered HTML back into Markdown. The source remains authoritative, so MDX and agent-authored structure stay round-trippable while the edit surface still reads like the rendered document.
