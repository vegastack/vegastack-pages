export { mcpInstructions, mcpInstructionsMaxBytes } from "./instructions";

/**
 * VegaStack Pages MCP — verb_noun surface, Notion-style.
 *
 * One mega-`fetch` for all reads (prefix-routed by resource_id) and distinct
 * verb_noun tools for every write. Industry convention per Notion / Slack /
 * Gmail MCPs and AWS prescriptive guidance: high-intent workflows, not
 * resource-CRUD discriminators.
 */
export const mcpToolNames = [
  // Reads — one mega-fetch + 3 specialized
  "fetch",
  "search",
  "wait_for_review",
  "whoami",
  // Page writes
  "create_page",
  "update_page",
  "restore_page_version",
  "move_page",
  // Comments
  "create_comment",
  "update_thread",
  "delete_thread",
  // Publications
  "apply_publication",
  "delete_publication",
  // Templates
  "create_template",
  "update_template",
  "render_template",
  // Attachments
  "upload_attachment",
  // Workspace
  "invite_workspace_member",
  "validate_page_source",
] as const;

export type McpToolName = (typeof mcpToolNames)[number];

export function isMcpToolName(value: string): value is McpToolName {
  return (mcpToolNames as readonly string[]).includes(value);
}

export type McpToolSpec = {
  name: McpToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const mcpToolSpecs = [
  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  {
    name: "fetch",
    description:
      "Fetch any VegaStack Pages resource (page, folder, template, comment thread, publication, workspace, or self) by its ID, optionally with sub-data via `include[]`. Routes on the resource_id prefix: pg_ → page, fld_ → folder, tpl_ → template, thr_ → comment thread, pub_ → publication, wks_ → workspace, 'me' → authenticated identity. Pass `resource_id: 'me'` to mirror the previous whoami response. Pass no resource_id with include=['workspaces'] to list workspaces.",
    inputSchema: {
      type: "object",
      required: ["workspace_id"],
      properties: {
        workspace_id: { type: "string" },
        resource_id: {
          type: "string",
          description:
            "Resource identifier with a type prefix. Use 'me' for the authenticated user, or omit and pass include=['workspaces'] to list workspaces accessible to the session.",
        },
        include: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "metadata",
              "source",
              "rendered",
              "versions",
              "comments",
              "publication",
              "edit_tokens",
              "members",
              "properties",
              "history",
              "review_events",
              "workspaces",
              "templates",
              "tree",
            ],
          },
          description:
            "Sub-data to include. The valid keys depend on resource type. For pages: source, rendered, versions, comments, publication, edit_tokens, history, review_events. For templates: properties. For workspaces: members, templates, tree. For 'me': workspaces.",
        },
        status: {
          type: "string",
          enum: ["open", "resolved", "all"],
          description:
            "Status filter when include contains 'comments'. Defaults to 'all'.",
        },
        depth: {
          type: "number",
          description: "Tree depth when include contains 'tree'.",
        },
      },
    },
  },
  {
    name: "search",
    description: "Search pages, folders, and comment threads in a workspace.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "query"],
      properties: {
        workspace_id: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
        type: {
          type: "string",
          enum: ["all", "page", "folder", "comment_thread", "comment"],
        },
      },
    },
  },
  {
    name: "wait_for_review",
    description:
      "Long-poll review events or comment state for a page. Returns the matched event when `until` fires, or times out cleanly.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        until: {
          type: "string",
          enum: [
            "first_response",
            "new_comment",
            "all_threads_resolved",
            "timeout",
          ],
        },
        after_event_id: { type: "string" },
        timeout_ms: { type: "number", minimum: 0, maximum: 600000 },
        poll_interval_ms: { type: "number", minimum: 250, maximum: 5000 },
      },
    },
  },
  {
    name: "whoami",
    description:
      "Return the authenticated MCP session: user id, email, accessible workspaces, session kind (manual | cli | oauth), and client name.",
    inputSchema: { type: "object", properties: {} },
  },

  // -------------------------------------------------------------------------
  // Page writes
  // -------------------------------------------------------------------------
  {
    name: "create_page",
    description:
      "Create a Markdown, MDX, or HTML page in the selected workspace. `title` is REQUIRED and becomes the persisted page title — every rendered surface (the public /p view, the editor header, search snippets) reads it directly. Do NOT duplicate the title as a top-level `# {title}` (markdown/mdx) or `<h1>{title}</h1>` (html) in `source`; the server strips a matching leading heading on persist so the title never displays twice. Pass `template_id` to render from a template; required template properties are supplied via `properties`. If you ALSO pass a non-empty `source` alongside `template_id`, `source` wins for the body and the template is used only to derive `source_type`.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "title"],
      properties: {
        workspace_id: { type: "string" },
        title: {
          type: "string",
          description:
            "Persisted page title. Required and must be a non-empty string. Do not also write it as a leading H1 in `source` — the server strips a matching leading heading on persist.",
        },
        source: { type: "string" },
        source_type: { type: "string", enum: ["markdown", "mdx", "html"] },
        folder_path: { type: "string" },
        template_id: {
          type: "string",
          description:
            "Template id (tpl_…) or slug. When provided, the page body is rendered from the template using `properties` for frontmatter fields — UNLESS a non-empty `source` is also passed, in which case `source` wins for the body.",
        },
        properties: {
          type: "object",
          description: "Frontmatter properties when using template_id.",
        },
      },
    },
  },
  {
    name: "update_page",
    description:
      "Update page source. Three modes (mutually exclusive): full source replace (provide `source`), find/replace patch (provide `find` and `replace`), or checkpoint-only snapshot (provide `checkpoint: true` with no source/find). All require `base_version_id` for optimistic concurrency; pages MUST be re-fetched via `fetch` with include=['edit_tokens'] when the version doesn't match.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id", "base_version_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        base_version_id: { type: "string" },
        base_content_hash: { type: "string" },
        // full-replace mode
        source: { type: "string" },
        // patch mode
        find: { type: "string" },
        replace: { type: "string" },
        replace_all: { type: "boolean" },
        expected_replacements: { type: "number" },
        // checkpoint mode
        checkpoint: { type: "boolean" },
        checkpoint_label: { type: "string" },
        // misc
        allow_noop: { type: "boolean" },
      },
    },
  },
  {
    name: "restore_page_version",
    description: "Restore a page from an existing saved version.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id", "version_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        version_id: { type: "string" },
      },
    },
  },
  {
    name: "move_page",
    description: "Rename and/or move a page to a new folder path.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        title: { type: "string" },
        folder_path: { type: "string" },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------
  {
    name: "create_comment",
    description:
      "Create a comment thread on a Markdown/MDX text selection or HTML point pin.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id", "body", "anchor"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        body: { type: "string" },
        anchor: {
          type: "object",
          description:
            "Use text anchors for Markdown/MDX with selected_text and optional source offsets/context. Use point anchors for HTML pins with anchor_kind: point, surface: html, and selector.point.",
          properties: {
            selected_text: { type: "string" },
            source_start: { type: "number" },
            source_end: { type: "number" },
            prefix_text: { type: "string" },
            suffix_text: { type: "string" },
            content_hash: { type: "string" },
            rendered_dom_path: { type: "string" },
            anchor_kind: { type: "string", enum: ["text", "point"] },
            surface: { type: "string", enum: ["prose", "html"] },
            confidence: {
              type: "string",
              enum: ["active", "reanchored", "fuzzy", "manual", "stale"],
            },
            selector: { type: "object" },
          },
        },
      },
    },
  },
  {
    name: "update_thread",
    description:
      "Mutate a comment thread in one call. Pass `body` to reply; `status` ('resolved' | 'open') or `resolve` (boolean) to change resolution; `anchor` to move the anchor; `complete: true` with `body` to write a closing reply and optionally resolve the thread in the same call. Multiple ops can be combined; the server applies them in this order: anchor → reply → resolve.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
        body: { type: "string" },
        status: { type: "string", enum: ["resolved", "open"] },
        resolve: { type: "boolean" },
        complete: {
          type: "boolean",
          description:
            "True to write `body` as a completion reply (with agent attribution) before resolving.",
        },
        anchor: {
          type: "object",
          description:
            "Same anchor object shape as create_comment. Point anchors require selector.point coordinates clamped to 0..1.",
        },
        agent_name: { type: "string" },
        agent_model: { type: "string" },
        agent_session_id: { type: "string" },
      },
    },
  },
  {
    name: "delete_thread",
    description:
      "Delete a full comment thread. Requires admin permission; prefer resolving via update_thread unless deletion is explicitly requested.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Publications
  // -------------------------------------------------------------------------
  {
    name: "apply_publication",
    description:
      "Create or update a page or folder publication. Handles both `resource_type: page` and `resource_type: folder`. Pass `publication_id` to update an existing publication; omit to create one.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "resource_type", "resource_id"],
      properties: {
        workspace_id: { type: "string" },
        resource_type: { type: "string", enum: ["page", "folder"] },
        resource_id: { type: "string" },
        publication_id: { type: "string" },
        permission: { type: "string", enum: ["view", "comment", "edit"] },
        expires_at: { type: "string" },
        clear_expires_at: { type: "boolean" },
        password: { type: "string" },
        clear_password: { type: "boolean" },
        indexing_enabled: { type: "boolean" },
      },
    },
  },
  {
    name: "delete_publication",
    description: "Revoke a page or folder publication.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "publication_id"],
      properties: {
        workspace_id: { type: "string" },
        publication_id: { type: "string" },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------
  {
    name: "create_template",
    description:
      "Create a workspace template from a structured builder. Use builder.sections for H2/H3/H4 blocks and properties for every frontmatter field, including select options and defaults.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "name", "builder"],
      properties: {
        workspace_id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        source_type: { type: "string", enum: ["markdown", "mdx"] },
        builder: { type: "object" },
        properties: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "update_template",
    description:
      "Edit an existing workspace template by id or slug. Provide builder to update the structured body and properties to replace the frontmatter field spec.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "template"],
      properties: {
        workspace_id: { type: "string" },
        template: {
          type: "string",
          description: "Template id (tpl_…) or slug.",
        },
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        source_type: { type: "string", enum: ["markdown", "mdx"] },
        builder: { type: "object" },
        properties: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "render_template",
    description:
      "Render a template into resolved Markdown without creating a page. Useful for drafting before committing.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "template", "title"],
      properties: {
        workspace_id: { type: "string" },
        template: { type: "string" },
        title: { type: "string" },
        properties: { type: "object" },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------
  {
    name: "upload_attachment",
    description: "Upload a base64-encoded asset to a page.",
    inputSchema: {
      type: "object",
      required: [
        "workspace_id",
        "page_id",
        "filename",
        "content_type",
        "base64_body",
      ],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        filename: { type: "string" },
        content_type: { type: "string" },
        base64_body: { type: "string" },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Workspace
  // -------------------------------------------------------------------------
  {
    name: "invite_workspace_member",
    description:
      "Invite a workspace member by email. Creates the user if missing, adds them at the requested role, and emails a magic link when email delivery is configured.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "email"],
      properties: {
        workspace_id: { type: "string" },
        email: { type: "string" },
        display_name: { type: "string" },
        role: {
          type: "string",
          enum: ["reader", "commenter", "editor", "admin"],
        },
      },
    },
  },
  {
    name: "validate_page_source",
    description:
      "Validate Markdown/MDX/HTML source for agent-editable issues, including common Mermaid 11 syntax traps. Read-only — never writes.",
    inputSchema: {
      type: "object",
      required: ["workspace_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        source: { type: "string" },
        source_type: { type: "string", enum: ["markdown", "mdx", "html"] },
      },
    },
  },
] satisfies McpToolSpec[];

export function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}
