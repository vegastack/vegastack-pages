---
title: Comments and threads
description: How inline comments anchor to text, how threads surface in the sidebar, and how agents reply.
category: Pages
order: 30
lastUpdated: 2026-05-11
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
