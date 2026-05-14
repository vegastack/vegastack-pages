export { mcpInstructions, mcpInstructionsMaxBytes } from "./instructions";

export const mcpToolNames = [
  "create_page",
  "update_page",
  "prepare_page_edit",
  "patch_page",
  "get_page",
  "get_rendered_page",
  "list_page_versions",
  "create_page_snapshot",
  "restore_page_version",
  "upload_attachment",
  "validate_page_source",
  "wait_for_review",
  "list_comments",
  "create_comment",
  "reply_to_thread",
  "resolve_thread",
  "unresolve_thread",
  "complete_review_thread",
  "update_comment_anchor",
  "delete_thread",
  "list_review_events",
  "publish_page",
  "publish_folder",
  "update_publication",
  "revoke_publication",
  "search_workspace",
  "search_pages",
  "list_workspace_tree",
  "move_page",
  "invite_workspace_member",
  "list_templates",
  "get_template",
  "create_template",
  "update_template",
  "render_template",
  "create_page_from_template",
  "list_workspaces",
  "whoami",
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

export const mcpToolSpecs: McpToolSpec[] = [
  {
    name: "create_page",
    description:
      "Create a Markdown, MDX, or HTML page in the selected workspace.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "title", "source"],
      properties: {
        workspace_id: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
        source_type: { type: "string", enum: ["markdown", "mdx", "html"] },
        folder_path: { type: "string" },
      },
    },
  },
  {
    name: "update_page",
    description: "Update page source with optimistic concurrency.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id", "source", "base_version_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        source: { type: "string" },
        base_version_id: { type: "string" },
        base_content_hash: { type: "string" },
        checkpoint: { type: "boolean" },
        checkpoint_label: { type: "string" },
        allow_noop: { type: "boolean" },
      },
    },
  },
  {
    name: "prepare_page_edit",
    description:
      "Fetch the live page source and edit tokens agents must use before updating.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
      },
    },
  },
  {
    name: "patch_page",
    description:
      "Safely replace text in the current page source and save only when the base version still matches.",
    inputSchema: {
      type: "object",
      required: [
        "workspace_id",
        "page_id",
        "base_version_id",
        "find",
        "replace",
      ],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        base_version_id: { type: "string" },
        base_content_hash: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        replace_all: { type: "boolean" },
        expected_replacements: { type: "number" },
        checkpoint: { type: "boolean" },
        checkpoint_label: { type: "string" },
      },
    },
  },
  {
    name: "get_page",
    description: "Read page metadata and source.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
      },
    },
  },
  {
    name: "get_rendered_page",
    description:
      "Read rendered page output, headings, frontmatter, and render mode.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
      },
    },
  },
  {
    name: "list_page_versions",
    description: "List saved versions for a page.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
      },
    },
  },
  {
    name: "create_page_snapshot",
    description:
      "Create a manual snapshot of the current page source before risky edits.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        label: { type: "string" },
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
    name: "upload_attachment",
    description: "Upload a base64 encoded attachment for a page.",
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
  {
    name: "validate_page_source",
    description:
      "Validate Markdown/MDX/HTML source for agent-editable issues, including common Mermaid 11 syntax traps.",
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
  {
    name: "wait_for_review",
    description: "Long-poll review events or comment state for a page.",
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
    name: "list_comments",
    description: "List page comment threads.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        status: { type: "string", enum: ["open", "resolved", "all"] },
      },
    },
  },
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
    name: "reply_to_thread",
    description:
      "Reply to a comment thread as the authenticated user. Use complete_review_thread for agent-attributed replies.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id", "body"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
        body: { type: "string" },
      },
    },
  },
  {
    name: "resolve_thread",
    description: "Resolve a comment thread.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
      },
    },
  },
  {
    name: "unresolve_thread",
    description: "Reopen a resolved comment thread.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
      },
    },
  },
  {
    name: "complete_review_thread",
    description:
      "Reply to a review thread with agent attribution and optionally resolve it in one call.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id", "body"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
        body: { type: "string" },
        resolve: { type: "boolean" },
        agent_name: { type: "string" },
        agent_model: { type: "string" },
        agent_session_id: { type: "string" },
      },
    },
  },
  {
    name: "update_comment_anchor",
    description:
      "Update a thread anchor after moving a fuzzy or stale HTML pin/comment marker.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id", "anchor"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
        anchor: {
          type: "object",
          description:
            "Same anchor object shape as create_comment. Point anchors require selector.point coordinates clamped to 0..1.",
        },
      },
    },
  },
  {
    name: "delete_thread",
    description:
      "Delete a full comment thread. Requires admin permission; prefer resolving unless deletion is explicitly requested.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "thread_id"],
      properties: {
        workspace_id: { type: "string" },
        thread_id: { type: "string" },
      },
    },
  },
  {
    name: "publish_page",
    description: "Publish one page at its canonical /p/{slug-id} URL.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "page_id"],
      properties: {
        workspace_id: { type: "string" },
        page_id: { type: "string" },
        permission: { type: "string", enum: ["view", "comment", "edit"] },
        expires_at: { type: "string" },
        password: { type: "string" },
        indexing_enabled: { type: "boolean" },
      },
    },
  },
  {
    name: "publish_folder",
    description:
      "Publish one folder subtree at its canonical /f/{slug-id} URL.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "folder_id"],
      properties: {
        workspace_id: { type: "string" },
        folder_id: { type: "string" },
        permission: { type: "string", enum: ["view", "comment", "edit"] },
        expires_at: { type: "string" },
        password: { type: "string" },
        indexing_enabled: { type: "boolean" },
      },
    },
  },
  {
    name: "update_publication",
    description:
      "Update an existing page or folder publication by publication id.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "publication_id"],
      properties: {
        workspace_id: { type: "string" },
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
    name: "revoke_publication",
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
  {
    name: "list_review_events",
    description:
      "List review events for a page or workspace after an optional cursor.",
    inputSchema: {
      type: "object",
      required: ["workspace_id"],
      properties: {
        page_id: { type: "string" },
        workspace_id: { type: "string" },
        after_id: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "search_workspace",
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
    name: "search_pages",
    description:
      "Search pages in the selected workspace. Use search_workspace for folders and comments too.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "query"],
      properties: {
        workspace_id: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "list_workspace_tree",
    description: "List folders and pages in a workspace.",
    inputSchema: {
      type: "object",
      required: ["workspace_id"],
      properties: { workspace_id: { type: "string" } },
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
  {
    name: "list_templates",
    description:
      "List workspace templates with their properties so the agent knows which scaffolds are available and what fields each one expects.",
    inputSchema: {
      type: "object",
      required: ["workspace_id"],
      properties: {
        workspace_id: { type: "string" },
        category: { type: "string" },
      },
    },
  },
  {
    name: "get_template",
    description:
      "Fetch a template's source, structured builder, and property spec. The source preserves <!-- guidance: ... --> comments so the agent knows what each section is for.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "template"],
      properties: {
        template: {
          type: "string",
          description: "Template id (tpl_…) or slug.",
        },
        workspace_id: { type: "string" },
      },
    },
  },
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
        builder: {
          type: "object",
          required: ["title", "sections"],
          properties: {
            title: {
              type: "string",
              description:
                'Usually "{{ title }}" so rendered pages use the page title.',
            },
            intro: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                required: ["level", "heading"],
                properties: {
                  level: { type: "number", enum: [2, 3, 4] },
                  heading: { type: "string" },
                  help_text: {
                    type: "string",
                    description:
                      "Visible helper copy rendered below the heading.",
                  },
                  guidance: {
                    type: "string",
                    description:
                      "Agent-only guidance stored as a Markdown HTML comment.",
                  },
                  body: {
                    type: "string",
                    description: "Optional starter Markdown for the section.",
                  },
                },
              },
            },
          },
        },
        properties: {
          type: "array",
          items: {
            type: "object",
            required: ["key", "label", "type"],
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              type: {
                type: "string",
                enum: [
                  "text",
                  "longtext",
                  "number",
                  "date",
                  "datetime",
                  "boolean",
                  "select",
                  "tags",
                ],
              },
              required: { type: "boolean" },
              default: {},
              options: {
                type: "array",
                items: { type: "string" },
                description: "Required when type is select.",
              },
              help: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "update_template",
    description:
      "Edit an existing workspace template by id or slug. Provide builder to update the structured H2/H3/H4 body and properties to replace the frontmatter field spec.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "template"],
      properties: {
        template: {
          type: "string",
          description: "Template id (tpl_…) or slug.",
        },
        workspace_id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        source_type: { type: "string", enum: ["markdown", "mdx"] },
        builder: {
          type: "object",
          properties: {
            title: { type: "string" },
            intro: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                required: ["level", "heading"],
                properties: {
                  level: { type: "number", enum: [2, 3, 4] },
                  heading: { type: "string" },
                  help_text: { type: "string" },
                  guidance: { type: "string" },
                  body: { type: "string" },
                },
              },
            },
          },
        },
        properties: {
          type: "array",
          items: {
            type: "object",
            required: ["key", "label", "type"],
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              type: {
                type: "string",
                enum: [
                  "text",
                  "longtext",
                  "number",
                  "date",
                  "datetime",
                  "boolean",
                  "select",
                  "tags",
                ],
              },
              required: { type: "boolean" },
              default: {},
              options: { type: "array", items: { type: "string" } },
              help: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "render_template",
    description:
      "Render a template into resolved markdown source without creating a page. Useful for drafting before committing.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "template", "title"],
      properties: {
        template: { type: "string" },
        workspace_id: { type: "string" },
        title: { type: "string" },
        properties: { type: "object" },
      },
    },
  },
  {
    name: "create_page_from_template",
    description:
      "Create a new page in the workspace from a template. Frontmatter is built from the provided properties; required properties must be supplied.",
    inputSchema: {
      type: "object",
      required: ["workspace_id", "template", "title"],
      properties: {
        template: { type: "string" },
        workspace_id: { type: "string" },
        title: { type: "string" },
        folder_path: { type: "string" },
        properties: { type: "object" },
      },
    },
  },
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
    name: "list_workspaces",
    description:
      "List workspaces the authenticated session can access. Returns id, name, slug, and the user's role for each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whoami",
    description:
      "Return the authenticated MCP session: user id, email, accessible workspaces, session kind (manual | cli | oauth), and client name.",
    inputSchema: { type: "object", properties: {} },
  },
];

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
