# Templates

Templates use a structured builder for predictable headings and per-section agent guidance.

```json
{
  "name": "Executive Review",
  "slug": "executive-review",
  "description": "Reusable executive review scaffold",
  "category": "agent",
  "source_type": "markdown",
  "builder": {
    "title": "{{ title }}",
    "intro": "Short visible introduction.",
    "sections": [
      {
        "level": 2,
        "heading": "Context",
        "help_text": "Visible helper copy.",
        "guidance": "Agent-only instruction stored as a Markdown comment.",
        "body": "- Starter bullet\n"
      },
      {
        "level": 3,
        "heading": "Risks",
        "guidance": "List material risks only."
      },
      { "level": 4, "heading": "Decision detail" }
    ]
  },
  "properties": [
    {
      "key": "owner",
      "label": "Owner",
      "type": "text",
      "required": true,
      "help": "Person accountable."
    },
    {
      "key": "status",
      "label": "Status",
      "type": "select",
      "options": ["draft", "review", "approved"],
      "default": "draft"
    }
  ]
}
```

Allowed values:

- Section `level`: `2`, `3`, or `4` (H2/H3/H4).
- `source_type`: `markdown` or `mdx`.
- Property `type`: `text`, `longtext`, `number`, `date`, `datetime`, `boolean`, `select` (needs `options`), `tags`.
- Each property may carry `required`, `default`, `help`, `placeholder`.

`guidance` renders as an HTML comment in source — visible to agents reading the page, hidden in rendered output.

## CLI

```sh
vpg --agent templates list
vpg --agent templates get tpl_review
vpg --agent templates render tpl_review --title "Q3 Plan" --set owner=platform
vpg --agent templates create --args-file template.json
vpg --agent templates update tpl_review --args-file template-update.json
```

## Create a page from a template

MCP: pass `template_id` to `create_page` with frontmatter values in `properties`.

```json
{
  "workspace_id": "wks_abc123",
  "title": "Q3 Plan",
  "template_id": "tpl_review",
  "properties": { "owner": "platform", "status": "draft" }
}
```

CLI: pass `--template tpl_review` to `vpg pages create` with `--set k=v` per property.

`render_template` returns the resolved Markdown without saving — useful for showing a draft to the user before committing.
