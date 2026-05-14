# Comments Redesign — Notion/Google Docs Style

Status: Draft for confirmation
Date: 2026-05-12

## 1. Feature Summary

Replace the current comments slide-over (panel-only, invisible highlights, click-to-navigate broken, selected text barely surfaced) with a layered model that mirrors Notion and Google Docs: persistent inline highlights for unresolved threads, floating thread cards anchored beside their highlights, and a secondary index/filter rail for navigating all threads. The page content shifts left when the rail is open. Resolved threads are hidden from the doc body but reachable from the rail, where clicking one scrolls to the location and pulses a temporary highlight.

## 2. Primary User Action

Select text → leave a comment grounded in that selection. Everything else in this surface exists to make that primary action, and the conversations it produces, easy to find, read, reply to, and resolve.

## 3. Design Direction

- **Color strategy:** Restrained. The token system routes all visual color through `packages/ui/src/styles.css`. Comments introduce semantic annotation and agent tokens on top:
  - **Comment accent:** the canonical annotation family used by Notion and Google Docs, implemented via `--vsk-comment-tint`, `--vsk-comment-tint-strong`, and `--vsk-comment-ink`.
  - **Agent accent:** unmistakable but calmer than comment highlighting, implemented via `--vsk-agent-tint`, `--vsk-agent-tint-strong`, and `--vsk-agent-ink`.
- **Theme scene sentence:** A senior reviewer is at their workstation between meetings, reading a 1200-word agent-drafted spec on a 14"-or-larger screen in normal office light. They want to triage three unresolved threads, leave a reply, and resolve one without losing reading flow. → Follow project token system (system theme default; equal polish in both light and dark).
- **Anchor references:**
  - Notion's right-rail comments (floating thread cards anchored to highlight Y, multiple can stay open, sidebar acts as index).
  - Google Docs' inline highlight + margin pin convention (always-visible highlight signals an open thread, even when no card is rendered).
  - Linear's thread typography (relaxed line-height, time stamps as muted micro-copy, no avatars-on-everything).

## 4. Scope

- **Fidelity:** Production-ready. Shipped quality, not sketch.
- **Breadth:** Whole reader surface (`/p/[slugId]`) — comments are the focus but adjacent affordances (doc-main grid, toolbar comment button, mark styling) are in scope where they touch comments.
- **Interactivity:** Live, interactive, integrated with existing API endpoints. No data-model changes; this is purely client-side + CSS.
- **Time intent:** Polish until it ships. Verify in browser before reporting complete.

## 5. Layout Strategy

### Three coordinated regions

```text
┌─────────────────────────────────────────────────────────────────────┐
│ doc-toolbar                                                          │
├──────────────┬──────────────────────────────────┬───────────────────┤
│              │                                  │                   │
│  sidebar     │     doc-content (shifts L when   │  comments rail    │
│  (workspace) │     rail open; max-w narrows)    │  ┌─────────────┐  │
│              │                                  │  │ Index/filter│  │
│              │     ──── [highlighted text] ──── │  ├─────────────┤  │
│              │                                  │  │             │  │
│              │     ...prose continues...        │  │ ┌──────────┐│  │
│              │                                  │  │ │ Thread A │┼──┐ floating card
│              │     more prose with [other       │  │ │ "...sel" ││  │ aligned to
│              │     highlighted span] inside.    │  │ │ Mira: ...││  │ highlight Y
│              │                                  │  │ │ [Reply]  ││  │
│              │                                  │  │ └──────────┘│  │
│              │                                  │  └─────────────┘  │
└──────────────┴──────────────────────────────────┴───────────────────┘
```

### Mechanics

- The reader surface (`/p/[slugId]`) is a CSS grid. Today: workspace sidebar + doc-main. New: workspace sidebar + doc-main + comments rail (when open).
- When the rail opens, `doc-main` does **not** get an overlay; the grid recalculates so the doc content has its max-width re-clamped (~720px) inside a narrower column. No scrim. No layout jump if avoided by transitioning the grid-template.
- The comments rail is `min(380px, 30vw)` on desktop and a full-width sheet on mobile (≤ 720px).
- The rail has three regions stacked: filter tabs, index of all visible threads (compact rows), and a clipped relative container that hosts the floating thread cards anchored to highlight Y.
- Floating cards stack with collision avoidance (already implemented; keep + improve animation curve).
- A thread is "active" when (a) the user clicked its highlight, (b) clicked its index row, or (c) clicked its card. Active thread gets elevated shadow + the doc highlight pulses once.

### Visual hierarchy

The body text remains the focal element. Comments are secondary signals layered on top:

- Highlights are tinted backgrounds at ~14% opacity; do not break line rhythm.
- Floating cards have a 1px border + soft elevation, never more.
- Index rows are compact, single-line where possible, two-line max.

## 6. Key States

| State                                          | What user sees                                                                                                                                                                                       | What they feel                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Default (rail closed)**                      | Doc at full reading width. Unresolved spans show subtle yellow tint. Resolved spans show nothing. Toolbar "comments" button shows unread badge.                                                      | Reading. Aware comments exist but undistracted.          |
| **Rail opened, no thread active**              | Doc shifts left, rail slides in, index of threads visible, no floating card.                                                                                                                         | "Where's the conversation I need."                       |
| **Thread active (open)**                       | Floating card appears beside highlight; index row is selected; doc highlight gets a one-time accent pulse. Multiple threads can be active simultaneously — cards stack with 10px gap, never overlap. | "I see the conversation in context."                     |
| **Thread active (resolved, opened from rail)** | Doc scrolls to where the resolved span used to be; a temporary 1.2s yellow flash appears (no persistent highlight); card opens floating beside that location.                                        | "I can revisit history without polluting the read view." |
| **Selecting text in doc**                      | Inline popover appears below selection with **the quoted selection visible at the top** (this is the missing bug), textarea, and Send / Cancel.                                                      | "I know what I'm commenting on."                         |
| **Thread with > 3 replies**                    | Card shows first reply + last 2 replies; a `… +N more replies` button between them expands the middle inline (accordion).                                                                            | "I don't lose context but I'm not flooded."              |
| **Empty (no comments)**                        | Rail shows: "Select text in the document to start a comment." No empty illustration.                                                                                                                 | Calm, instructive, not decorative.                       |
| **Loading**                                    | Existing fetch is fast; no loading state needed for index. Inline composer disables Send while posting.                                                                                              | No flash, no spinner.                                    |
| **Network error**                              | Inline status line under composer, muted text. No toast.                                                                                                                                             | Recoverable.                                             |
| **Reduced motion**                             | All animations disabled. Highlight pulse becomes a 500ms sustained tint, then drops. Card position changes are instant.                                                                              | No vestibular discomfort.                                |

## 7. Interaction Model

### Creating a comment

1. User selects text in `[data-vpg-doc-content]`.
2. Inline composer popover appears anchored to the selection's bounding rect.
3. Popover header: tiny "Comment" label + a close (×) button.
4. Popover quote block: the selected text, with a left rule (3px), serif font, max 4 lines truncated with "…" if longer. **This is the currently-missing piece — adding it is required.**
5. Optional guest name field (only when `guestNameRequired`).
6. Textarea, autofocused.
7. Footer: ghost "Cancel" + primary "Comment" (rename from "Send" — matches Notion).
8. Cmd/Ctrl+Enter submits.
9. On success: popover dismisses, rail auto-opens (if closed), new thread fades in active.

### Reading and navigating

- **Hover an unresolved highlight in the doc** → cursor changes to pointer; subtle tint deepens.
- **Click a highlight** → opens the rail if closed, scrolls index to the row, opens the floating card. Card receives focus on its first interactive element.
- **Click an index row** → same as clicking the highlight: doc scrolls so the highlight is centered, mark pulses, card opens.
- **Click a card** → activates the thread (marks the index row, pulses the highlight). Replies in the card become interactive.
- **Click outside a card** (not on another comment surface) → card closes; another thread can be active.
- **Esc** → closes the active card; second Esc closes the rail.
- **Cmd/Ctrl+Shift+M** → toggle rail (new shortcut; existing toggle only by button).
- **Reply** → input at card foot, Cmd/Ctrl+Enter submits.
- **Resolve** → checkmark button on card AND row; resolving collapses the card with a 200ms fade-out and removes the doc highlight in the same timing.
- **Reopen a resolved thread** → click the row in "Resolved" or "All" tab; doc scrolls, temporary flash plays, card opens. Card has a "Reopen" button instead of "Resolve".

### Reply collapse / expand

- Card always renders: first reply (the thread opener) + last 2 replies.
- If `replies.length > 3`, render a `… +{n - 3} more` button between reply 1 and the last 2. Click → in-place expansion (no modal, no separate route).
- Collapsed state preserves scroll position of the card body.

### Time formatting

- < 60s: "just now"
- < 60m: "{n}m ago"
- < 24h: "{n}h ago"
- yesterday: "yesterday at h:mm a"
- < 7 days: "{weekday} at h:mm a"
- this year: "Mon D"
- older: "Mon D, YYYY"

Tooltip on hover: full ISO timestamp in local time.

### Agent vs human visual model

- **Highlight tint:** human-authored threads use `--vsk-comment-tint` (yellow). Agent-authored threads (i.e., the thread's first reply is an agent) use `--vsk-agent-tint` (teal). One or the other; threads don't mix.
- **Avatar in card:** human → initials in neutral circle. Agent → bot glyph in teal circle.
- **Author row:** agent has a small "AI" pill next to the name, with the model name in mono micro-copy on the line below ("claude-opus-4-7 · session 8f3a").
- **Reply mix:** if any reply in the thread is from an agent, that single reply (not the whole thread) gets a teal left rule (1px); thread tint stays whatever the opener was.

## 8. Content Requirements

| Surface                           | Copy                                              |
| --------------------------------- | ------------------------------------------------- |
| Composer header                   | "Comment"                                         |
| Composer placeholder              | "Add a comment…"                                  |
| Composer primary button           | "Comment" (replaces "Send")                       |
| Composer cancel                   | "Cancel"                                          |
| Composer guest name label         | "Your name"                                       |
| Composer name placeholder         | "Jane Reviewer"                                   |
| Reply placeholder                 | "Reply…"                                          |
| Reply submit                      | "Reply"                                           |
| Resolve button (aria)             | "Resolve thread"                                  |
| Reopen button (aria)              | "Reopen thread"                                   |
| Reply collapse pill               | "Show {n} more {n === 1 ? 'reply' : 'replies'}"   |
| Reply collapsed-back pill         | "Show fewer"                                      |
| Empty (Open tab)                  | "Select text in the document to start a comment." |
| Empty (Resolved tab)              | "No resolved threads yet."                        |
| Empty (All tab)                   | "No comments on this page."                       |
| Rail title                        | "Comments"                                        |
| Rail close (aria)                 | "Close comments"                                  |
| Toolbar button (aria, with count) | "Comments — {n} open"                             |
| Toolbar button (aria, none)       | "Comments"                                        |
| Network failure under composer    | "Comment didn't send. Try again."                 |
| Agent badge                       | "AI"                                              |
| Time labels                       | Per §7 "Time formatting"                          |

Anti-copy: no "Crushing it!", no "🎉", no "Inbox zero", no encouragement copy. Reviewers are working, not playing.

## 9. Recommended References

For implementation, lean on:

- `reference/spatial-design.md` — the three-region grid coordination, rail width, doc-content max-width recalc, mobile sheet behavior.
- `reference/motion-design.md` — highlight pulse curve, card fade-in, reduced-motion fallback.
- `reference/interaction-design.md` — focus management when card opens, Esc layering, keyboard reachability for highlights.

Tokens to add in `packages/ui/src/styles.css`: `--vsk-comment-tint`,
`--vsk-comment-tint-strong`, `--vsk-comment-ink`, `--vsk-agent-tint`,
`--vsk-agent-tint-strong`, and `--vsk-agent-ink`. Literal color values belong
only in the shared palette file, not in this plan or component code.

## 10. Open Questions

1. **Page-shift transition timing:** should the doc squeeze when the rail opens (animated `grid-template-columns`) or should the rail overlay narrowly? Recommendation: animated shift, 240ms ease-out-quart, because the spec already says "the page moves left to show the comments rail." Confirm OK.
2. **Highlight on selection conflict:** what if two threads anchor to overlapping spans? Notion uses stacked tints (darker where they overlap). Recommendation: implement Notion's stacking via `color-mix` to add an extra 10% tint; keep both highlights clickable (click target is the topmost; cards stack open). Confirm acceptable for v1.
3. **Permission for inline highlights:** should guests with read-only access see highlights (they don't own threads)? Recommendation: yes, highlights visible to anyone with comment-read permission. Confirm.
4. **Keyboard shortcut for comment toggle (Cmd/Ctrl+Shift+M):** any conflict with existing app shortcuts? `001-ui-ux.md` lists Cmd+F, Cmd+K, Esc, Cmd+S, e, v. No conflict, but confirm.

---

## Confirmation gate

This brief is the design requirements doc. Once you confirm (or amend) it, implementation proceeds in this order, no further questions unless the open questions above land in a non-default answer:

1. New tokens in `packages/ui/src/styles.css` (and `@media (prefers-color-scheme: dark)`, and `:root[data-theme="dark"]`).
2. Quote block in `inline-comment-popover` (the missing "selected text isn't coming up" piece).
3. Visible inline highlights on unresolved threads (`vpg-comment-mark` gets a default tint, not transparent).
4. Doc-main grid shift on rail open (new CSS for `.app-shell` / `.doc-main` to reserve space).
5. Floating card anchored-to-highlight: keep current Y-anchor logic, fix click-to-scroll (`flashThreadMark` already exists — verify it works now that marks have visible tints).
6. Reply collapse with `+N more` accordion in `CommentsPanel`.
7. Human-friendly relative time in `formatCommentTime`.
8. Agent visual differentiation (tint variant + AI badge + model micro-copy).
9. Keyboard: Esc layering, optional Cmd/Ctrl+Shift+M.
10. Browser verification (light + dark, with and without `prefers-reduced-motion`).
