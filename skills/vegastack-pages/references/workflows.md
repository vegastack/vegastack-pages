# Workflows

## Create A Page For Review

MCP:

1. `create_page` or `create_page_from_template`.
2. `publish_page` with comment permission if an external reviewer needs access.
3. Tell the user the page public URL and that you are waiting for review for up to 10 minutes.
4. `wait_for_review` using `timeout_ms: 600000` and `after_event_id` when continuing an existing wait.
5. When comments arrive, act on them immediately; do not wait for the user to paste the comments back into chat.

CLI:

```sh
vpg create --file draft.md --title "Draft"
vpg publish-page pg_123 --permission comment
vpg wait pg_123 --until first-response --timeout-seconds 600
```

## Address Comments

1. List comments/events.
2. For each actionable thread, inspect `anchor_context`; text anchors map to Markdown/MDX source, while HTML pins use selector/point context.
3. Validate proposed source.
4. Patch with expected replacement count.
5. Reply and resolve with the same agent identity.

MCP:

```text
list_comments -> prepare_page_edit -> validate_page_source -> patch_page -> complete_review_thread
```

CLI:

```sh
vpg comments pg_123 --status open
vpg pages prepare-edit pg_123
vpg pages patch pg_123 --base-version-id ver_123 --base-content-hash hash_123 --find "old" --replace "new" --expected-replacements 1
vpg complete-thread cmt_123 --body "Updated the wording." --resolve --agent-name Codex
```

## Recover From Conflicts

When a patch/update reports a conflict, never force the old payload. Fetch the current source again, recompute the edit, then retry with the new version and content hash.

For larger edits, create a snapshot first with `create_page_snapshot` or `vpg pages snapshot`. Use `list_page_versions` / `vpg pages versions` to find saved versions, and restore only after confirming the target version is the intended rollback point.

## User Interruptions

The VegaStack Pages API can time out waits, but it cannot see the host chat's incoming messages. If the agent harness interrupts a wait because the user sends a new message, stop the wait, respond to the user, then continue review polling only when it still matches the user's intent.
