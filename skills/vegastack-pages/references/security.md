# Security And Reliability

- Treat MCP and CLI tokens as secrets. Do not write them into pages, templates, skills, logs, or generated files.
- Workspace-scoped tokens only operate in their issuing workspace.
- Prefer MCP when connected; prefer CLI for shell automation. Do not run both for the same mutation unless intentionally coordinating.
- Always use `prepare_page_edit` or `vpg pages prepare-edit` before source changes.
- Always include `base_version_id`; include `base_content_hash` when available.
- Use expected replacement counts for patches.
- On conflict, refetch and retry. Do not bypass concurrency checks.
- Use `validate_page_source` or `vpg pages validate` before saving substantial edits.
- Avoid returning magic-link URLs or invite tokens to untrusted logs.
- Do not install skills automatically from package install scripts. Use explicit `vpg skills install --agent all --scope user` and avoid overwriting user files unless `--force` is set.
- After npm updates, refresh installed global skills with `vpg skills update --agent all --scope user`; this overwrites only the VegaStack Pages skill/adapters managed by the current binary.
