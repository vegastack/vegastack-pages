# Comments and anchors

Use when leaving, inspecting, moving, replying to, resolving, or deleting review feedback.

## Reading

`fetch include: ["comments"]` (MCP) or `vpg comments list <page>` (CLI). Both honor `status: "open" | "resolved" | "all"` (defaults: MCP `all`, CLI `open`).

Inspect on every thread:

- `surface` — `prose` (Markdown/MDX) or `html` (HTML preview pins).
- `kind` — `text` (selected text in source) or `point` (visual coordinate).
- `confidence` — `active` is safe to act on; `fuzzy`, `reanchored`, `stale`, `manual` mean read `nearbyText` / `prefixText` / `suffixText` before mutating source.
- `selectedText`, `prefixText`, `suffixText`, `sourceStart`, `sourceEnd` — text anchor span.
- `selector.point`, `selector.element`, `selector.textHit`, `nearbyText` — HTML pin context.

## Anchor coercion (server rules)

The server normalizes anchors via `coerceCommentAnchor` before storing them:

- `anchor_kind: "text"` + `surface: "prose"` — must include `selected_text`; `source_start` / `source_end` accepted; offsets optional if `prefix_text` + `suffix_text` are sufficient to locate the span.
- `anchor_kind: "point"` + `surface: "html"` — must include `selector.point` with `x`, `y` in `[0, 1]` (`coordinateSpace: "document"`). Offsets are ignored.
- Mixing `point` with `surface: "prose"` or `text` with `surface: "html"` is rejected.

## Markdown / MDX text comments

MCP:

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_xyz789",
  "body": "Please clarify this.",
  "anchor": {
    "selected_text": "ambiguous phrase",
    "source_start": 120,
    "source_end": 136,
    "prefix_text": "The ",
    "suffix_text": " needs",
    "anchor_kind": "text",
    "surface": "prose"
  }
}
```

CLI:

```sh
vpg --agent comments create pg_xyz789 \
  --body "Please clarify this." \
  --selected-text "ambiguous phrase" \
  --source-start 120 --source-end 136 \
  --anchor-kind text --surface prose
```

If you don't know offsets, send `selected_text` + `prefix_text` + `suffix_text` and let the server place it.

## HTML pin comments

HTML pages render in an isolated preview; comments are point pins, not text anchors.

```json
{
  "workspace_id": "wks_abc123",
  "page_id": "pg_html",
  "body": "This hero CTA needs the final copy.",
  "anchor": {
    "selected_text": "Pinned comment",
    "anchor_kind": "point",
    "surface": "html",
    "confidence": "manual",
    "selector": {
      "point": { "x": 0.52, "y": 0.34, "coordinateSpace": "document" },
      "element": {
        "path": "main:nth-of-type(1)>section:nth-of-type(1)>a:nth-of-type(1)",
        "tag": "a",
        "id": "hero-cta",
        "text": "Start"
      },
      "nearbyText": "Start"
    }
  }
}
```

CLI: pass the anchor as JSON via `--anchor-file`:

```sh
vpg --agent comments create pg_html --body "..." --anchor-file html-pin.json
```

## Acting on comments

1. List threads, filter to actionable ones.
2. For text comments: `fetch include: ["source","edit_tokens"]`, validate, patch with find/replace, reply.
3. For HTML pins: edit markup/CSS/copy; validate as `html`; reply.
4. Resolve only after the change is in. Use `update_thread status: "open"` (MCP) or `vpg comments reopen` (CLI) to undo a premature resolve.
5. Move a fuzzy/stale anchor with `update_thread anchor: {...}` or `vpg comments move-anchor` — don't rewrite anchors while addressing feedback.
6. Delete only on explicit request; emits a `comment.deleted` review event and removes the whole conversation (admin-only).

## Agent attribution

For agent-generated replies, attach `agent_name`, `agent_model`, `agent_session_id`:

```json
{
  "workspace_id": "wks_abc123",
  "thread_id": "thr_456",
  "body": "Fixed.",
  "complete": true,
  "status": "resolved",
  "agent_name": "Claude",
  "agent_model": "claude-opus-4-7",
  "agent_session_id": "sess_42"
}
```

```sh
vpg --agent comments complete thr_456 --body "Fixed." --resolve \
  --agent-name Claude --agent-model claude-opus-4-7 --agent-session-id sess_42
```

## CLI cheat sheet

```sh
vpg --agent comments list pg_xyz789 --status open
vpg --agent comments reply thr_456 --body "Thanks, fixed."
vpg --agent comments resolve thr_456
vpg --agent comments reopen thr_456
vpg --agent comments complete thr_456 --body "Fixed and verified." --resolve --agent-name Claude
vpg --agent comments delete thr_456 --yes
vpg --agent comments move-anchor thr_456 --anchor-file html-pin.json
```
