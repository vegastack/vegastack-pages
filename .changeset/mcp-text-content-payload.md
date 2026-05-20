---
"@vegastack/pages": patch
---

Fix MCP tool results to include the full payload as serialized JSON in
the `TextContent` block, not a one-line summary. Per the MCP spec
(2025-11-25), tools that populate `structuredContent` SHOULD also
serialize the JSON into a `TextContent` block for backwards
compatibility — most clients (Claude.ai, Cursor) read from
`content[0].text` and ignore `structuredContent` unless the tool
declares an `outputSchema`. The previous behavior collapsed every
tool response to a string like `"VegaStack Pages:fetch: ok"`,
leaving callers with no usable data and breaking template-driven
workflows ("create a page from a template"). The dead
`compactToolText` helper is removed.
