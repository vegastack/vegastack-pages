# Comments And Anchors

Use comment tools when the task is to leave, inspect, move, reply to, resolve, or delete review feedback.

## Reading Comments

`list_comments` / `vpg comments` returns threads with `anchor_context`. Always inspect:

- `surface`: `prose` for rendered Markdown/MDX, `html` for HTML preview pins.
- `kind`: `text` for selected text, `point` for pinned coordinates.
- `confidence`: `active` is reliable; `fuzzy` or `stale` means inspect nearby context before editing.
- `selectedText`, `prefixText`, `suffixText`, `sourceStart`, `sourceEnd`: use these to find the exact source span.
- `selector`: for HTML pins, use `selector.point`, `selector.element`, `selector.textHit`, and `nearbyText` to locate the visual target.

## Markdown And MDX Text Comments

Create text comments with `anchor_kind: "text"` and `surface: "prose"`.

MCP:

```json
{
  "workspace_id": "wks_123",
  "page_id": "pg_123",
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
vpg comment pg_123 --body "Please clarify this." --selected-text "ambiguous phrase" --source-start 120 --source-end 136 --prefix-text "The " --suffix-text " needs"
```

If offsets are unknown, provide selected text plus prefix/suffix. The API will try to place the anchor in source.

## HTML Pin Comments

HTML pages render in an isolated preview. Comments are usually point pins, not source-text anchors. Create them with `anchor_kind: "point"`, `surface: "html"`, and a `selector.point` coordinate. Coordinates are normalized from `0` to `1`.

MCP:

```json
{
  "workspace_id": "wks_123",
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

CLI:

```sh
vpg comment pg_html --body "This hero CTA needs the final copy." --anchor-file html-pin.json
```

Use `update_comment_anchor` / `vpg update-anchor` only to move a fuzzy, stale, or manually repositioned pin. Do not rewrite anchors while addressing text feedback unless the comment is clearly disconnected.

## Acting On Comments

1. List comments and identify actionable threads.
2. For text comments, fetch source with `prepare_page_edit` / `vpg pages prepare-edit`, patch with concurrency tokens, then validate.
3. For HTML pin comments, inspect the HTML source and selector context. Patch the relevant markup, CSS, or copy. Validate as `html`.
4. Reply with what changed. Resolve only after the feedback is handled.
5. Use `update_thread` with `status: "open"` / `vpg unresolve` if a thread was resolved by mistake.
6. Delete threads only when explicitly requested; deletion requires admin permission and removes the whole conversation.
