---
"@vegastack/pages": patch
---

`create_page` (MCP + CLI) now respects a caller-supplied `source` when
`template_id` is also passed. Previously the template render
unconditionally won and the caller's `source` was silently discarded —
which broke agent workflows where Claude had already drafted prose and
expected the template to only contribute structure/frontmatter. The new
precedence: if `source` is a non-empty string, it wins for the body;
the template_id is then used only to derive `source_type` and to
validate that the supplied properties match a known schema. Omit
`source` (or pass an empty string) to get the previous behavior — a
fresh template render. Tool description and the agent-facing
instructions in `@vegastack/pages-mcp` are updated to spell out the
precedence rule explicitly.
