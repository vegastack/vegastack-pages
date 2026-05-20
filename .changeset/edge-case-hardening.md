---
"@vegastack/pages": patch
---

End-to-end edge-case hardening across MCP, CLI, and the settings UI.

- **Attachment uploads via base64 actually decoded.** Both the MCP
  `upload_attachment` tool and the JSON `POST /api/pages/:id/attachments`
  path (used by `vpg attachments upload`) were storing the _base64
  string_ as the object body — the service layer UTF-8-encoded it as
  bytes, so every non-text attachment downloaded afterwards returned
  the base64 text instead of the original binary. Both paths now
  decode the base64 into raw bytes before storing, and surface a
  `VALIDATION_ERROR` for malformed input.
- **`update_thread` with `complete: true` requires a body.** Previously
  passing `complete: true` without a body silently dropped the
  closing-reply intent and left the thread open. It now errors with
  `VALIDATION_ERROR`.
- **`move_page` requires at least one of `title` or `folder_path`.**
  Calling `move_page` with neither was a silent no-op that returned
  success — confusing for agents expecting an error.
- **Members table action icons render at 16px.** The styling rule lived
  in `docs.css`, which `SettingsLayout` does not import, so the icons
  were falling back to lucide-react's 24px default and dominating the
  row. Icons now ship with explicit `size={16}` props AND a
  defense-in-depth CSS rule moved into `settings.css`.
