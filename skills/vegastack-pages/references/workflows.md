# Workflows

## Create a page for review

MCP:

1. `create_page` (with `template_id` to render from a template).
2. `apply_publication` with `permission: "comment"` if the reviewer is outside the workspace.
3. Tell the user the public URL and announce a ~10-minute wait.
4. `wait_for_review` with `timeout_ms: 600000`. Carry the last seen `after_event_id` when resuming so events aren't re-delivered.
5. Act on events immediately — never wait for the user to paste them.

CLI:

```sh
vpg --agent pages create --file draft.md --title "Draft" --type markdown --folder-path guides
vpg --agent publish page pg_xyz789 --permission comment
vpg --agent pages wait pg_xyz789 --until first-response --timeout 600
```

## Address comments

```
fetch (include: ["comments"], status: "open")
  -> fetch (include: ["source", "edit_tokens"])
  -> validate_page_source
  -> update_page (find/replace, expected_replacements: 1)
  -> update_thread (complete: true, status: "resolved", agent_name/model/session_id)
```

CLI:

```sh
vpg --agent comments list pg_xyz789 --status open
vpg --agent pages get pg_xyz789 --include source,edit_tokens
vpg --agent validate --page pg_xyz789
vpg --agent pages update pg_xyz789 \
  --base-version-id ver_42 --base-content-hash sha256:f00 \
  --find "old" --replace "new" --expected-replacements 1
vpg --agent comments complete thr_456 \
  --body "Updated the wording." --resolve --agent-name Claude
```

## Recover from conflicts

`update_page` / `vpg pages update` returns `VPG_CONFLICT` (HTTP 409, CLI exit 6) when `base_version_id` or `base_content_hash` is stale. Never retry with the same payload.

```
fetch (include: ["source", "edit_tokens"])   # refresh tokens
  -> recompute find/replace from current source
  -> update_page with new base_version_id (+ base_content_hash)
```

For risky multi-edit sequences, snapshot first:

```
update_page { checkpoint: true, checkpoint_label: "before rewrite" }
```

To roll back, `fetch include: ["versions"]` (or `vpg pages versions`), then `restore_page_version` / `vpg pages restore` after confirming the target.

## Dedupe in wait_for_review

`wait_for_review` returns every matching event since `after_event_id`. The dedupe set is per call — if you start a fresh wait without `after_event_id`, you will re-receive events you already handled. Always thread the latest `evt_…` id forward when resuming.

## User interruptions

The API can time out a wait but cannot see incoming chat messages. If the host harness interrupts a wait with a new user message, stop polling, answer the user, then resume polling only if it still matches intent.

## Validate first

Run `validate_page_source` / `vpg validate` before any non-trivial edit, especially for Mermaid blocks (11.x syntax traps), MDX with JSX, or HTML with embedded scripts. It is read-only and cheap.
