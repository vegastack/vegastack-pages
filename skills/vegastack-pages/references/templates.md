# Templates

Templates use a structured builder for predictable headings and agent guidance.

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
      {
        "level": 4,
        "heading": "Decision detail"
      }
    ]
  },
  "properties": [
    {
      "key": "owner",
      "label": "Owner",
      "type": "text",
      "required": true,
      "help": "Person accountable for the page."
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

Heading `level` values are `2`, `3`, or `4`. Frontmatter field `type` values are `text`, `longtext`, `number`, `date`, `datetime`, `boolean`, `select`, and `tags`.
