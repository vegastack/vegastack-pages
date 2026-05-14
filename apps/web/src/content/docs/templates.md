---
title: Templates
description: Create repeatable page structures for PRDs, RFCs, runbooks, launch plans, and other agent-authored knowledge.
category: Agents
order: 15
lastUpdated: 2026-05-14
---

Templates make agent output consistent. A template is a reusable page scaffold with headings, optional visible helper text, hidden guidance comments, and typed properties that render into frontmatter.

## What templates contain

| Part          | Purpose                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Name and slug | Human label and stable identifier used by UI, CLI, and MCP.                                           |
| Category      | Product, engineering, marketing, business, work, or your own grouping.                                |
| Source type   | Markdown or MDX. Pages created from templates keep that source type.                                  |
| Builder       | Structured title, intro, and h2/h3/h4 sections.                                                       |
| Guidance      | Markdown comments such as `<!-- guidance: ... -->` that tell agents what each section should contain. |
| Properties    | Typed fields rendered into frontmatter.                                                               |

Property types are `text`, `longtext`, `number`, `date`, `datetime`, `boolean`, `select`, and `tags`.

## Built-in templates

New workspaces are seeded with editable templates:

| Category    | Templates                                                                |
| ----------- | ------------------------------------------------------------------------ |
| Product     | PRD, feature brief, discovery notes                                      |
| Engineering | RFC/tech design, postmortem, ADR, runbook                                |
| Marketing   | Launch plan, campaign brief                                              |
| Business    | Executive one-pager                                                      |
| Work        | Meeting notes, weekly update, 1:1 agenda, project kickoff, retrospective |

Built-ins are normal workspace rows. You can edit or delete them.

## Browser workflow

1. Open **Settings > Templates**.
2. Create or edit a template.
3. Define fields in the properties table.
4. Add guidance comments inside each section.
5. Use **New from template** in the sidebar.

The page created from a template is a normal page. It has versions, comments, attachments, sharing, search, and Backup to Git like any other page.

## MCP workflow

Agents can list, read, render, create, and update templates:

```js
await mcp.call("list_templates", {
  workspace_id: "wks_123",
});

await mcp.call("create_page_from_template", {
  workspace_id: "wks_123",
  template_id: "prd",
  title: "Search redesign",
  properties: {
    owner: "platform",
    status: "review",
  },
});
```

`get_template` returns source with guidance comments intact so agents can follow the intended structure.

## CLI workflow

```sh
vpg --workspace wks_123 templates list
vpg --workspace wks_123 templates show prd
vpg --workspace wks_123 templates render prd --title "Search redesign" --set owner=platform
vpg --workspace wks_123 create --template prd --title "Search redesign" --set owner=platform
```

Template create and update commands accept JSON:

```json
{
  "name": "Executive Review",
  "slug": "executive-review",
  "description": "Reusable executive review scaffold",
  "category": "business",
  "builder": {
    "title": "{{ title }}",
    "sections": [
      {
        "level": 2,
        "heading": "Context",
        "guidance": "State why this decision matters now."
      }
    ]
  },
  "properties": [
    {
      "key": "owner",
      "label": "Owner",
      "type": "text",
      "required": true
    }
  ]
}
```

## Notes

- Template slugs must be unique inside a workspace.
- Heading levels in the structured builder are `2`, `3`, or `4`.
- Updating template source creates template versions.
- Creating a page from a template emits normal page-created audit and review events.
