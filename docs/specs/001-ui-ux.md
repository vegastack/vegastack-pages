# UI And UX Specification

Status: Draft  
Date: 2026-05-10

## Design Principles

- The app is a document workspace, not a marketing site.
- Read mode should feel calm, fast, and polished.
- Edit mode should feel like a serious source editor, not a fragile rich-text editor.
- Comments should behave like modern Notion/Google Docs comments.
- Page organization should feel familiar to Notion users.
- The app must work cleanly on desktop, tablet, and mobile.
- WCAG 2.2 AA is required.

## Visual System

- Color: Vega neutral tokens, with light, dark, and system theme modes.
- Application font: Geist.
- Document content font: modern serif.
- Code font: modern monospace aligned with CodeMirror and Shiki.
- Cards: restrained, no nested cards.
- Buttons: icon buttons where the action is visually familiar.
- Icons: use a maintained icon set where available; rendered/source mode uses eye and pencil icons.
- Theme: a compact theme menu offers System, Light, and Dark. System follows the browser preference.

## Main Layout

Desktop:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ VegaStack Pages     Search...                         Share  Comments  User │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│ Workspace     │ Get Started                         [eye][pen]│ Threads       │
│               │ ───────────                                  │               │
│ ▾ Product     │ title: Get Started                           │ ● Intro note  │
│   Overview    │ type: guide                                  │   selected... │
│   Roadmap     │ updated: 2026-05-10                          │   Reply       │
│ ▾ Agents      │                                              │               │
│   Skills      │ # Welcome                                    │ ○ Resolved    │
│   MCP Setup   │                                              │               │
│               │ Clean document content with serif reading     │               │
│ + New Page    │ typography, code blocks, diagrams, images.    │               │
└───────────────┴──────────────────────────────────────────────┴───────────────┘
```

Mobile:

- Left tree collapses behind a workspace/pages button.
- Comment panel opens as a drawer.
- Read/edit icon buttons remain visible near the document title.
- Editing is full-screen with source editor controls.
- Search opens as a full-screen command palette.

## Rendered Mode

Rendered mode is the default when opening a page.

Elements:

- Page title.
- Metadata table from frontmatter for all docs.
- Rendered document body.
- Table of contents.
- Inline unresolved comment highlights.
- Comment sidebar or drawer.
- Share button.
- Mode switch icon buttons.

Behavior:

- Selecting text opens an inline comment affordance.
- Clicking a highlight focuses the thread.
- Resolved comments are hidden by default.
- Code blocks have copy buttons.
- Headings have anchor links.
- Mermaid diagrams render reliably.
- Attachments load through permission-checked URLs.

## Source Edit Mode

Source edit mode uses CodeMirror 6.

Elements:

- Full-page source editor.
- Save/autosave status.
- Conflict warning if source version changed elsewhere.
- Mode switch icon buttons.
- Markdown/MDX/HTML language mode.
- Optional command actions for snapshot, upload attachment, and insert link.

Behavior:

- Autosave updates draft/current source.
- Checkpoint versions are created by policy.
- MDX remains source-first.
- HTML pages require explicit source mode to edit.
- No default split/live preview.

## Comments UX

Right sidebar:

```text
┌──────────── Threads ────────────┐
│ ● API wording                   │
│   "selected text..."            │
│   Mira: Can we clarify this?    │
│   Agent: Proposed update...     │
│   [Reply] [Resolve]             │
│                                 │
│ ● Error handling                │
│   [Reply] [Resolve]             │
└─────────────────────────────────┘
```

Requirements:

- Comment anchors remain stable through reasonable edits.
- Threads show selected text context.
- Agent replies show agent name/model/session metadata.
- Resolved threads are hidden by default.
- Sidebar supports filtering unresolved/resolved/all.
- On mobile, comment sidebar becomes a drawer.

## Share Dialog

```text
┌──────────────────────── Share Page ────────────────────────┐
│ Link: /p/api-review-a8f31c                                 │
│ Permission:  View ▾   Comment   Edit                       │
│ Expires:     Never ▾                                       │
│ Password:    Optional                                      │
│ Search indexing: Off                                       │
│                                                            │
│ [Copy link]                                      [Save]     │
└────────────────────────────────────────────────────────────┘
```

Defaults:

- Permission: view.
- Expiry: never.
- Password: none.
- Search indexing: off.

## Setup Wizard

```text
┌──────────────── VegaStack Pages Setup ────────────────┐
│ Create first admin                                    │
│ Email                                                  │
│ Temporary setup token                                  │
│ Workspace name                                         │
│ Storage: Cloudflare R2                                 │
│ Database: Cloudflare D1                                │
│ [Create instance]                                      │
└───────────────────────────────────────────────────────┘
```

Setup creates a seeded workspace with:

- Get Started
- Agent Review Workflow
- MCP Setup
- CLI Setup
- Skills folder
- Plans folder

## Keyboard Shortcuts

- `Cmd/Ctrl+F`: current page search.
- `Cmd/Ctrl+K`: command palette and accessible page search.
- `Esc`: close dialog/drawer.
- `Cmd/Ctrl+S`: force save/checkpoint in source edit mode.
- `e`: source edit mode when focused in document and user has write access.
- `v`: rendered mode when focused in editor.

Shortcuts must not interfere with CodeMirror typing behavior.

## Accessibility

Required:

- Icon buttons have accessible labels.
- Mode state is announced.
- Comment highlights have keyboard navigation.
- Share dialog traps focus.
- Command palette is keyboard complete.
- Page tree supports arrow navigation.
- Color contrast meets WCAG 2.2 AA.
- Resolved/unresolved state is conveyed beyond color.
