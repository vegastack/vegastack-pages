---
title: Comments and threads
description: How inline comments anchor to text, how threads surface in the sidebar, and how agents reply.
category: Pages
order: 30
lastUpdated: 2026-05-20
---

Reviewers select rendered Markdown/MDX text or pin a location in an HTML preview. Each comment becomes a thread.

## Anchoring

Text threads store selected text, source offsets, the rendered DOM path, surrounding prefix and suffix text, and fuzzy re-anchor metadata. If the source changes around the selection, the thread re-anchors to the new position when possible.

HTML threads usually use point anchors. A point anchor stores normalized coordinates plus selector context such as element path, tag, id, nearby text, and optional text hit. When a pin becomes stale or fuzzy, move the anchor instead of creating a duplicate thread.

Agents should treat `anchor_context.surface === "prose"` as a Markdown/MDX source edit and `anchor_context.surface === "html"` as an HTML/CSS/copy edit guided by selector context.

## The sidebar

Threads live in the right sidebar in rendered mode and become a drawer on mobile. The sidebar supports filtering by unresolved, resolved, and all. Resolved threads are hidden by default. Threads can be replied to, resolved, and unresolved by users with the appropriate permission.

## Agent replies

Agent replies are typed replies with metadata: agent name, model, session ID, the user account they are running under, and a timestamp. The thread visually marks agent replies so reviewers know which lines came from a machine.

## Guest reviewers

Public review links may grant comment or edit access. Guests must enter a display name once before commenting. The display name is recorded on the thread so agents can attribute future replies.

## Keyboard

`Esc` closes a thread. Arrow keys navigate threads in the sidebar. `Cmd/Ctrl+Enter` submits a reply.

## Agent surface

Comments are first-class in both MCP and the CLI.

### MCP

`update_thread` is one tool that handles every thread mutation. Combine fields freely — the server applies anchor → reply → resolve in that order.

```js
// Create a thread on selected Markdown text.
await mcp.call("create_comment", {
  workspace_id: "wks_123",
  page_id: "pg_123",
  body: "Clarify this.",
  anchor: {
    selected_text: "old phrase",
    source_start: 142,
    source_end: 152,
    anchor_kind: "text",
    surface: "prose",
  },
});

// Reply + resolve in one call, with agent attribution.
await mcp.call("update_thread", {
  workspace_id: "wks_123",
  thread_id: "thr_99",
  body: "Done.",
  resolve: true,
  agent_name: "Claude",
  agent_model: "opus-4.7",
  agent_session_id: "sess_42",
});

// Move an anchor on an HTML point pin.
await mcp.call("update_thread", {
  workspace_id: "wks_123",
  thread_id: "thr_99",
  anchor: {
    anchor_kind: "point",
    surface: "html",
    selector: { point: { x: 0.42, y: 0.18 } },
  },
});

// Complete-and-resolve in a single call (writes a closing reply tagged as agent completion).
await mcp.call("update_thread", {
  workspace_id: "wks_123",
  thread_id: "thr_99",
  complete: true,
  body: "Shipped in ver_42.",
  resolve: true,
  agent_name: "Claude",
});
```

Read threads via `fetch` with `include=["comments"]` and a `status` filter:

```js
await mcp.call("fetch", {
  workspace_id: "wks_123",
  resource_id: "pg_123",
  include: ["comments"],
  status: "open",
});
```

### CLI

```sh
vpg comments list pg_123 --status open
vpg comments create pg_123 --body "Clarify this." --selected-text "old phrase"
vpg comments create pg_html --body "Move this CTA." --anchor-file html-pin.json --anchor-kind point --surface html
vpg comments reply thr_99 --body "Done." --agent-name Claude --agent-model opus-4.7
vpg comments complete thr_99 --body "Fixed." --resolve --agent-name Claude
vpg comments move-anchor thr_99 --anchor-file html-pin.json --anchor-kind point --surface html
vpg comments resolve thr_99
vpg comments reopen thr_99
vpg comments delete thr_99                          # admin only; confirms y/N

# --agent mode (--yes required for delete):
vpg --agent comments reply thr_99 --body "Done." --agent-name Claude
vpg --agent --yes comments delete thr_99
```

Agent-attributed replies (`vpg comments reply` and `vpg comments complete` with `--agent-name`, `--agent-model`, `--agent-session-id`) carry the metadata the sidebar uses to mark the reply as machine-authored.
