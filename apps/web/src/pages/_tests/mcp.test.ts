import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { mcpToolNames } from "@vegastack/pages-mcp";
import { GET, HEAD, POST } from "../mcp";
import {
  auditService,
  authService,
  commentService,
  workspaceService,
} from "../../lib/runtime";

type JsonRpcResponse = {
  id: unknown;
  result?: {
    structuredContent?: Record<string, unknown>;
  };
  error?: {
    message: string;
    data?: {
      error?: {
        code?: string;
        details?: Record<string, unknown>;
      };
    };
  };
};

afterEach(() => {
  delete process.env.VPG_MCP_TOKEN;
  delete process.env.VPG_MCP_AUTH_REQUIRED;
  delete process.env.VPG_MCP_ALLOWED_ORIGINS;
  delete process.env.VPG_RETURN_VERIFY_URL_IN_INVITE;
  delete process.env.VPG_DEV_AUTO_LOGIN;
  delete process.env.VPG_ALLOW_STATIC_MCP_TOKEN;
  delete process.env.VPG_MCP_STATIC_USER_EMAIL;
  delete process.env.VPG_MCP_WORKSPACE_ID;
});

describe("MCP route", () => {
  it("rejects GET with a transport-focused 405", async () => {
    const response = await GET({} as never);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, GET, HEAD, OPTIONS");
    expect(response.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  it("answers HEAD with 200 and the MCP protocol version for connector discovery", async () => {
    const response = await HEAD({} as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toBe("");
  });

  it("includes MCP protocol version on the 401 used to start OAuth discovery", async () => {
    delete process.env.VPG_DEV_AUTO_LOGIN;

    const response = await POST({
      request: new Request("http://127.0.0.1:4322/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      }),
    } as never);

    expect(response.status).toBe(401);
    expect(response.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("accepts initialized notifications without a response body", async () => {
    const response = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("requires auth by default unless runtime dev auto-login is enabled", async () => {
    delete process.env.VPG_DEV_AUTO_LOGIN;

    const response = await POST({
      request: new Request("http://127.0.0.1:4322/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      }),
    } as never);

    expect(response.status).toBe(401);
  });

  it("requires bearer auth when VPG_MCP_TOKEN is configured", async () => {
    process.env.VPG_MCP_TOKEN = "test-token";

    const unauthorized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const authorized = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { Authorization: "Bearer test-token" },
    );
    expect(authorized.status).toBe(200);
  });

  it("exposes the VegaStack Pages skill through MCP resources and prompts", async () => {
    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const initBody = (await initialized.json()) as {
      result?: { capabilities?: Record<string, unknown> };
    };
    expect(initBody.result?.capabilities).toHaveProperty("prompts");

    const listed = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
      params: {},
    });
    const listedBody = (await listed.json()) as {
      result?: { resources?: Array<{ uri: string }> };
    };
    expect(listedBody.result?.resources?.map((item) => item.uri)).toContain(
      "vpg://skills/vegastack-pages/SKILL.md",
    );

    const read = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "vpg://skills/vegastack-pages/SKILL.md" },
    });
    const readBody = (await read.json()) as {
      result?: { contents?: Array<{ text: string }> };
    };
    expect(readBody.result?.contents?.[0]?.text).toContain(
      "name: vegastack-pages",
    );

    const prompts = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "prompts/list",
      params: {},
    });
    const promptsBody = (await prompts.json()) as {
      result?: { prompts?: Array<{ name: string }> };
    };
    expect(promptsBody.result?.prompts?.map((item) => item.name)).toContain(
      "vegastack_edit_page_safely",
    );

    const prompt = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "prompts/get",
      params: {
        name: "vegastack_edit_page_safely",
        arguments: { page_id: "pg_123", change: "Tighten wording" },
      },
    });
    const promptBody = (await prompt.json()) as {
      result?: { messages?: Array<{ content?: { text?: string } }> };
    };
    expect(promptBody.result?.messages?.[0]?.content?.text).toContain(
      "prepare_page_edit",
    );

    const reviewPrompt = await post({
      jsonrpc: "2.0",
      id: 6,
      method: "prompts/get",
      params: {
        name: "vegastack_review_page",
        arguments: { page_id: "pg_123" },
      },
    });
    const reviewPromptBody = (await reviewPrompt.json()) as {
      result?: { messages?: Array<{ content?: { text?: string } }> };
    };
    const reviewText = reviewPromptBody.result?.messages?.[0]?.content?.text;
    expect(reviewText).toContain("wait_for_review");
    expect(reviewText).toContain("600000");
    expect(reviewText).toContain("act on them immediately");
  });

  it("does not compare static MCP bearer tokens with strict equality", () => {
    const source = readFileSync(new URL("../mcp.ts", import.meta.url), "utf8");

    expect(source.includes("bearer === token")).toBe(false);
    expect(source.includes("constantTimeEqual(bearer, token)")).toBe(true);
  });

  it("requires workspace scoping and audits explicitly enabled static MCP token use", async () => {
    const workspace = workspaceService.createWorkspace({
      id: `wks_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      name: "Static MCP Audit",
    });
    const user = workspaceService.createUser({
      id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      email: `static-mcp-${crypto.randomUUID()}@example.test`,
      displayName: "Static MCP User",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: "admin",
    });
    process.env.VPG_MCP_TOKEN = "test-token";
    process.env.VPG_ALLOW_STATIC_MCP_TOKEN = "true";
    process.env.VPG_MCP_STATIC_USER_EMAIL = user.email;

    const unscoped = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { Authorization: "Bearer test-token" },
    );
    expect(unscoped.status).toBe(400);

    process.env.VPG_MCP_WORKSPACE_ID = workspace.id;
    const scoped = await post(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
      { Authorization: "Bearer test-token" },
    );

    expect(scoped.status).toBe(200);
    expect(
      auditService
        .list({ workspaceId: workspace.id })
        .some((log) => log.action === "mcp.static_token_used"),
    ).toBe(true);
  });

  it("requires explicit workspace ids for workspace-scoped tool calls", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_page",
        arguments: {
          title: "Missing Workspace",
          source: "# Missing Workspace",
        },
      },
    });
    const body = (await response.json()) as JsonRpcResponse;

    expect(body.error?.message).toBe("workspace_id is required.");
    expect(body.error?.data?.error?.code).toBe("WORKSPACE_REQUIRED");
  });

  it("rejects browser session ids as MCP bearer tokens", async () => {
    process.env.VPG_MCP_TOKEN = "test-token";
    const user = workspaceService.createUser({
      email: `mcp-browser-session-${crypto.randomUUID()}@example.com`,
      displayName: "MCP Browser Session",
    });
    const session = authService.createSession(user.id);

    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { Authorization: `Bearer ${session.id}` },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("supports the safe fetch-patch flow and loudly rejects stale edits", async () => {
    const created = await callTool("create_page", {
      workspace_id: "wks_demo",
      folder_path: "agents",
      title: `MCP Patch Test ${Date.now()}`,
      source_type: "markdown",
      source: "# MCP Patch Test\n\nOriginal text.",
    });
    const pageId = String(created.page_id);

    const prepared = await callTool("prepare_page_edit", {
      workspace_id: "wks_demo",
      page_id: pageId,
    });
    expect(prepared.source).toContain("Original text.");

    const patched = await callTool("patch_page", {
      workspace_id: "wks_demo",
      page_id: pageId,
      base_version_id: prepared.base_version_id,
      base_content_hash: prepared.base_content_hash,
      find: "Original text.",
      replace: "Updated text.",
      expected_replacements: 1,
    });

    expect(patched.changed).toBe(true);
    expect(patched.replacement_count).toBe(1);

    const stale = await post({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "update_page",
        arguments: {
          workspace_id: "wks_demo",
          page_id: pageId,
          base_version_id: prepared.base_version_id,
          source: "# Stale",
        },
      },
    });
    const staleBody = (await stale.json()) as JsonRpcResponse;

    expect(staleBody.id).toBe(9);
    expect(staleBody.error?.message).toContain("changed since it was loaded");
    expect(staleBody.error?.data?.error?.code).toBe("CONFLICT");
  });

  it("rejects moving a page into a missing folder path", async () => {
    const created = await callTool("create_page", {
      workspace_id: "wks_demo",
      folder_path: "",
      title: `MCP Folder Move ${Date.now()}`,
      source_type: "markdown",
      source: "# MCP Folder Move",
    });
    const pageId = String(created.page_id);

    const response = await post({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "move_page",
        arguments: {
          workspace_id: "wks_demo",
          page_id: pageId,
          folder_path: "missing/folder",
        },
      },
    });
    const body = (await response.json()) as JsonRpcResponse;

    expect(body.error?.message).toBe("Folder was not found in this workspace.");
    expect(body.error?.data?.error?.code).toBe("FOLDER_NOT_FOUND");
  });

  it("caps wait_for_review timeout and rejects concurrent waits for the same actor and page", async () => {
    const source = readFileSync(new URL("../mcp.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "clampNumber(args.timeout_ms, 600_000, 0, 600_000)",
    );

    const created = await callTool("create_page", {
      workspace_id: "wks_demo",
      folder_path: "",
      title: `MCP Wait ${Date.now()}`,
      source_type: "markdown",
      source: "# MCP Wait",
    });
    const pageId = String(created.page_id);
    const request = (id: number) =>
      post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "wait_for_review",
          arguments: {
            workspace_id: "wks_demo",
            page_id: pageId,
            until: "new_comment",
            timeout_ms: 120,
            poll_interval_ms: 250,
          },
        },
      });

    const responses = await Promise.all([request(11), request(12)]);
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as JsonRpcResponse[];

    expect(
      bodies.some((body) => body.error?.data?.error?.code === "RATE_LIMITED"),
    ).toBe(true);
  });

  it("reports known Mermaid syntax traps", async () => {
    const result = await callTool("validate_page_source", {
      workspace_id: "wks_demo",
      source: [
        "```mermaid",
        "xychart-beta",
        '  x-axis ["2018", "2019"]',
        "```",
        "",
        "```mermaid",
        "graph TD",
        "  A[Cost + $5]",
        "```",
      ].join("\n"),
    });

    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.diagnostics)).toContain(
      "mermaid_xychart_quoted_axis",
    );
    expect(JSON.stringify(result.diagnostics)).toContain(
      "mermaid_graph_symbol_label",
    );
  });

  it("creates and updates templates from structured builder payloads", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await callTool("create_template", {
      workspace_id: "wks_demo",
      name: `MCP Template ${suffix}`,
      slug: `mcp-template-${suffix}`,
      description: "Created over MCP",
      category: "agent",
      source_type: "markdown",
      builder: {
        title: "{{ title }}",
        intro: "Use this template for MCP-authored plans.",
        sections: [
          {
            level: 2,
            heading: "Context",
            help_text: "What prompted this work?",
            guidance: "Summarize the business and technical context.",
            body: "- Background\n",
          },
          {
            level: 3,
            heading: "Risks",
            guidance: "List material risks only.",
          },
        ],
      },
      properties: [
        {
          key: "status",
          label: "Status",
          type: "select",
          required: true,
          options: ["draft", "review", "approved"],
          default: "draft",
          help: "Current lifecycle state.",
        },
        {
          key: "audience",
          label: "Audience",
          type: "text",
          default: "engineering",
        },
      ],
    });

    const createdTemplate = created.template as Record<string, unknown>;
    expect(createdTemplate.slug).toBe(`mcp-template-${suffix}`);
    expect(createdTemplate.properties).toEqual([
      {
        key: "status",
        label: "Status",
        type: "select",
        required: true,
        default: "draft",
        options: ["draft", "review", "approved"],
        help: "Current lifecycle state.",
      },
      {
        key: "audience",
        label: "Audience",
        type: "text",
        required: false,
        default: "engineering",
      },
    ]);
    expect(created.source).toContain("## Context");
    expect(created.source).toContain("<!-- guidance: Summarize");
    const createdBuilder = created.builder as {
      title: string;
      sections: Array<{ level: number; heading: string }>;
    };
    expect(createdBuilder.title).toBe("{{ title }}");
    expect(createdBuilder.sections[0]).toMatchObject({
      level: 2,
      heading: "Context",
    });

    const templateId = String(createdTemplate.id);
    const updated = await callTool("update_template", {
      workspace_id: "wks_demo",
      template: templateId,
      name: `MCP Template Updated ${suffix}`,
      builder: {
        title: "{{ title }}",
        intro: "Updated intro.",
        sections: [
          {
            level: 4,
            heading: "Decision details",
            help_text: "Capture the final detail.",
            guidance: "Be concrete and cite tradeoffs.",
          },
        ],
      },
      properties: [
        {
          key: "status",
          label: "Status",
          type: "select",
          options: ["draft", "approved"],
          default: "approved",
        },
      ],
    });

    const updatedTemplate = updated.template as Record<string, unknown>;
    expect(updatedTemplate.name).toBe(`MCP Template Updated ${suffix}`);
    expect(updated.source).toContain("#### Decision details");
    const updatedBuilder = updated.builder as {
      intro: string;
      sections: Array<{ level: number; heading: string }>;
    };
    expect(updatedBuilder.intro).toBe("Updated intro.");
    expect(updatedBuilder.sections[0]).toMatchObject({
      level: 4,
      heading: "Decision details",
    });
    expect(updatedTemplate.properties).toEqual([
      {
        key: "status",
        label: "Status",
        type: "select",
        required: false,
        default: "approved",
        options: ["draft", "approved"],
      },
    ]);
  });

  it("exercises every MCP tool locally and exposes page/tree resources alongside skills", async () => {
    const workspaceId = "wks_demo";
    const suffix = crypto.randomUUID().slice(0, 8);
    const exercised = new Set<string>();
    const tool = async (name: string, args: Record<string, unknown>) => {
      exercised.add(name);
      return callTool(name, args);
    };

    const created = await tool("create_page", {
      workspace_id: workspaceId,
      folder_path: "",
      title: `MCP All Tools ${suffix}`,
      source_type: "markdown",
      source: "# MCP All Tools\n\nOriginal local MCP coverage body.",
    });
    const pageId = String(created.page_id);

    const fetched = await tool("get_page", {
      workspace_id: workspaceId,
      page_id: pageId,
    });
    expect(JSON.stringify(fetched)).toContain(
      "Original local MCP coverage body",
    );

    const renderedPage = await tool("get_rendered_page", {
      workspace_id: workspaceId,
      page_id: pageId,
    });
    expect(String(renderedPage.html)).toContain("MCP All Tools");
    expect(renderedPage.render_mode).toBe("html");

    let prepared = await tool("prepare_page_edit", {
      workspace_id: workspaceId,
      page_id: pageId,
    });
    const updated = await tool("update_page", {
      workspace_id: workspaceId,
      page_id: pageId,
      base_version_id: prepared.base_version_id,
      base_content_hash: prepared.base_content_hash,
      source: "# MCP All Tools\n\nUpdated local MCP coverage body.",
    });
    expect(updated.changed).toBe(true);

    prepared = await tool("prepare_page_edit", {
      workspace_id: workspaceId,
      page_id: pageId,
    });
    const patched = await tool("patch_page", {
      workspace_id: workspaceId,
      page_id: pageId,
      base_version_id: prepared.base_version_id,
      base_content_hash: prepared.base_content_hash,
      find: "Updated local MCP coverage body.",
      replace: "Patched local MCP coverage body.",
      expected_replacements: 1,
    });
    expect(patched.replacement_count).toBe(1);

    const snapshot = await tool("create_page_snapshot", {
      workspace_id: workspaceId,
      page_id: pageId,
      label: "local MCP coverage snapshot",
    });
    const versions = await tool("list_page_versions", {
      workspace_id: workspaceId,
      page_id: pageId,
    });
    expect(JSON.stringify(versions.versions)).toContain(
      String(snapshot.version_id),
    );
    const restored = await tool("restore_page_version", {
      workspace_id: workspaceId,
      page_id: pageId,
      version_id: String(snapshot.version_id),
    });
    expect(restored.changed).toBe(false);

    const validation = await tool("validate_page_source", {
      workspace_id: workspaceId,
      page_id: pageId,
    });
    expect(validation.valid).toBe(true);

    const uploaded = await tool("upload_attachment", {
      workspace_id: workspaceId,
      page_id: pageId,
      filename: `mcp-${suffix}.txt`,
      content_type: "text/plain",
      base64_body: "SGVsbG8=",
    });
    expect(String(uploaded.url)).toContain("workspace_id=wks_demo");

    const moved = await tool("move_page", {
      workspace_id: workspaceId,
      page_id: pageId,
      title: `MCP All Tools Moved ${suffix}`,
      folder_path: "agents",
    });
    const movedPage = moved.page as Record<string, unknown>;
    expect(movedPage.folderPath).toBe("agents");

    const createdComment = await tool("create_comment", {
      workspace_id: workspaceId,
      page_id: pageId,
      body: "Please address this local MCP test comment.",
      anchor: {
        selected_text: "Patched local",
        source_start: 16,
        source_end: 29,
        prefix_text: "",
        suffix_text: "",
        content_hash: String(patched.content_hash),
      },
    });
    const thread = createdComment.thread as Record<string, unknown>;
    const threadId = String(thread.id);
    const listedComments = await tool("list_comments", {
      workspace_id: workspaceId,
      page_id: pageId,
      status: "all",
    });
    expect(JSON.stringify(listedComments)).toContain(threadId);

    const replied = await tool("reply_to_thread", {
      workspace_id: workspaceId,
      thread_id: threadId,
      body: "Acknowledged by local MCP test.",
    });
    const replyRecord = replied.reply as Record<string, unknown>;
    expect(replyRecord.authorType).toBe("user");

    const agentReply = await tool("complete_review_thread", {
      workspace_id: workspaceId,
      thread_id: threadId,
      body: "Resolved by agent on its own.",
      resolve: false,
      agent_name: "Vitest Agent",
      agent_model: "local",
      agent_session_id: `agt_${suffix}`,
    });
    const agentReplyRecord = agentReply.reply as Record<string, unknown>;
    expect(agentReplyRecord.agentName).toBe("Vitest Agent");

    const resolved = await tool("resolve_thread", {
      workspace_id: workspaceId,
      thread_id: threadId,
    });
    const resolvedThread = resolved.thread as Record<string, unknown>;
    expect(resolvedThread.status).toBe("resolved");

    const unresolved = await tool("unresolve_thread", {
      workspace_id: workspaceId,
      thread_id: threadId,
    });
    const unresolvedThread = unresolved.thread as Record<string, unknown>;
    expect(unresolvedThread.status).toBe("open");

    const reresolved = await tool("resolve_thread", {
      workspace_id: workspaceId,
      thread_id: threadId,
    });
    const reresolvedThread = reresolved.thread as Record<string, unknown>;
    expect(reresolvedThread.status).toBe("resolved");

    const htmlPage = await tool("create_page", {
      workspace_id: workspaceId,
      folder_path: "",
      title: `MCP HTML Pins ${suffix}`,
      source_type: "html",
      source:
        '<!doctype html><html><body><main><h1 id="hero">Hero</h1></main></body></html>',
    });
    const htmlPageId = String(htmlPage.page_id);
    const htmlComment = await tool("create_comment", {
      workspace_id: workspaceId,
      page_id: htmlPageId,
      body: "Pin this HTML hero.",
      anchor: {
        selected_text: "Pinned comment",
        anchor_kind: "point",
        surface: "html",
        confidence: "manual",
        selector: {
          point: {
            x: 0.25,
            y: 0.35,
            coordinateSpace: "document",
          },
          element: {
            path: "main:nth-of-type(1)>h1:nth-of-type(1)",
            tag: "h1",
            id: "hero",
            text: "Hero",
          },
          nearbyText: "Hero",
        },
      },
    });
    const htmlThread = htmlComment.thread as Record<string, unknown>;
    const htmlThreadId = String(htmlThread.id);
    const anchorUpdate = await tool("update_comment_anchor", {
      workspace_id: workspaceId,
      thread_id: htmlThreadId,
      anchor: {
        selected_text: "Pinned comment",
        anchor_kind: "point",
        surface: "html",
        confidence: "manual",
        selector: {
          point: {
            x: 0.5,
            y: 0.6,
            coordinateSpace: "document",
          },
          element: {
            path: "main:nth-of-type(1)>h1:nth-of-type(1)",
            tag: "h1",
            id: "hero",
            text: "Hero",
          },
        },
      },
    });
    const updatedAnchor = anchorUpdate.anchor as Record<string, unknown>;
    expect(updatedAnchor.surface).toBe("html");

    const deletedThread = await tool("delete_thread", {
      workspace_id: workspaceId,
      thread_id: htmlThreadId,
    });
    const deletedRecord = deletedThread.thread as Record<string, unknown>;
    expect(deletedRecord.id).toBe(htmlThreadId);

    const secondThread = commentService.createThread({
      pageId,
      workspaceId,
      body: "Second local MCP test comment.",
      anchor: {
        selectedText: "coverage",
        sourceStart: 0,
        sourceEnd: 8,
        prefixText: "",
        suffixText: "",
        contentHash: String(patched.content_hash),
      },
    });
    const completed = await tool("complete_review_thread", {
      workspace_id: workspaceId,
      thread_id: secondThread.thread.id,
      body: "Handled in local MCP coverage.",
      resolve: true,
      agent_name: "Vitest Agent",
      agent_model: "local",
      agent_session_id: `agt_${suffix}`,
    });
    const completedThread = completed.resolved as Record<string, unknown>;
    expect(completedThread.status).toBe("resolved");

    const waited = await tool("wait_for_review", {
      workspace_id: workspaceId,
      page_id: pageId,
      until: "all_threads_resolved",
      timeout_ms: 0,
    });
    expect(waited.status).toBe("matched");

    const events = await tool("list_review_events", {
      workspace_id: workspaceId,
      page_id: pageId,
      limit: 20,
    });
    expect(Array.isArray(events.events)).toBe(true);

    const publication = await tool("publish_page", {
      workspace_id: workspaceId,
      page_id: pageId,
      permission: "comment",
      password: "strong-passphrase",
      expires_at: "2099-01-01T00:00:00.000Z",
      indexing_enabled: true,
    });
    expect(String(publication.url)).toContain("/p/");
    const publicationId = String(publication.publication_id);

    const preservedPublication = await tool("publish_page", {
      workspace_id: workspaceId,
      page_id: pageId,
      permission: "view",
    });
    const preservedPublicationRecord =
      preservedPublication.publication as Record<string, unknown>;
    expect(preservedPublicationRecord.expiresAt).toBe(
      "2099-01-01T00:00:00.000Z",
    );
    expect(preservedPublicationRecord.passwordHash).toBeTruthy();
    expect(preservedPublicationRecord.indexingEnabled).toBe(true);

    const agentsFolder = workspaceService
      .listFolders(workspaceId)
      .find((folder) => folder.path === "agents");
    expect(agentsFolder).toBeDefined();
    const folderPublication = await tool("publish_folder", {
      workspace_id: workspaceId,
      folder_id: agentsFolder!.id,
      permission: "view",
      indexing_enabled: false,
    });
    const folderPublicationRecord = folderPublication.publication as Record<
      string,
      unknown
    >;
    expect(folderPublicationRecord.permission).toBe("view");

    const updatedPublication = await tool("update_publication", {
      workspace_id: workspaceId,
      publication_id: publicationId,
      permission: "view",
      clear_password: true,
      indexing_enabled: false,
    });
    const updatedPublicationRecord = updatedPublication.publication as Record<
      string,
      unknown
    >;
    expect(updatedPublicationRecord.permission).toBe("view");
    expect(updatedPublicationRecord.passwordHash).toBeNull();

    const revokedPublication = await tool("revoke_publication", {
      workspace_id: workspaceId,
      publication_id: publicationId,
    });
    const revokedPublicationRecord = revokedPublication.publication as Record<
      string,
      unknown
    >;
    expect(revokedPublicationRecord.revokedAt).toBeTruthy();

    const search = await tool("search_pages", {
      workspace_id: workspaceId,
      query: `MCP All Tools Moved ${suffix}`,
      limit: 10,
    });
    expect(JSON.stringify(search.results)).toContain(pageId);

    const workspaceSearch = await tool("search_workspace", {
      workspace_id: workspaceId,
      query: `MCP All Tools Moved ${suffix}`,
      type: "all",
      limit: 10,
    });
    expect(JSON.stringify(workspaceSearch.results)).toContain(pageId);

    const tree = await tool("list_workspace_tree", {
      workspace_id: workspaceId,
    });
    expect(JSON.stringify(tree.pages)).toContain(pageId);

    const templates = await tool("list_templates", {
      workspace_id: workspaceId,
    });
    expect(Array.isArray(templates.templates)).toBe(true);

    const template = await tool("create_template", {
      workspace_id: workspaceId,
      name: `MCP All Tools Template ${suffix}`,
      slug: `mcp-all-tools-template-${suffix}`,
      description: "Local MCP coverage template.",
      category: "agent",
      builder: {
        title: "{{ title }}",
        intro: "Intro for local MCP coverage.",
        sections: [
          {
            level: 2,
            heading: "Summary",
            help_text: "Visible help.",
            guidance: "Agent guidance.",
            body: "Starter body.",
          },
        ],
      },
      properties: [
        {
          key: "owner",
          label: "Owner",
          type: "text",
          required: true,
          default: "Docs",
        },
      ],
    });
    const createdTemplate = template.template as Record<string, unknown>;
    const templateId = String(createdTemplate.id);

    const gotTemplate = await tool("get_template", {
      workspace_id: workspaceId,
      template: templateId,
    });
    expect(gotTemplate.source).toContain("## Summary");

    const rendered = await tool("render_template", {
      workspace_id: workspaceId,
      template: templateId,
      title: `Rendered ${suffix}`,
      properties: { owner: "Runtime" },
    });
    expect(rendered.source).toContain("owner: Runtime");

    const updatedTemplate = await tool("update_template", {
      workspace_id: workspaceId,
      template: templateId,
      builder: {
        title: "{{ title }}",
        sections: [{ level: 3, heading: "Updated Summary" }],
      },
    });
    expect(updatedTemplate.source).toContain("### Updated Summary");

    const templatedPage = await tool("create_page_from_template", {
      workspace_id: workspaceId,
      template: templateId,
      title: `MCP Template Page ${suffix}`,
      folder_path: "guides",
      properties: { owner: "Runtime" },
    });
    expect(String(templatedPage.page_id)).toMatch(/^pg_/);

    const invited = await tool("invite_workspace_member", {
      workspace_id: workspaceId,
      email: `mcp-all-tools-${suffix}@example.test`,
      display_name: "MCP All Tools Invite",
      role: "reader",
    });
    expect(invited.magic_link_created).toBe(true);

    const skillRead = await post({
      jsonrpc: "2.0",
      id: "read-skill",
      method: "resources/read",
      params: { uri: "vpg://skills/vegastack-pages/references/mcp.md" },
    });
    const skillBody = (await skillRead.json()) as {
      result?: { contents?: Array<{ text: string }> };
    };
    expect(skillBody.result?.contents?.[0]?.text).toContain(
      "Every MCP tool call requires an explicit `workspace_id`",
    );

    const pageResource = await post({
      jsonrpc: "2.0",
      id: "read-page",
      method: "resources/read",
      params: { uri: `vpg://pages/${pageId}` },
    });
    const pageResourceBody = (await pageResource.json()) as {
      result?: { contents?: Array<{ text: string }> };
    };
    expect(pageResourceBody.result?.contents?.[0]?.text).toContain(
      "Patched local MCP coverage body.",
    );

    const treeResource = await post({
      jsonrpc: "2.0",
      id: "read-tree",
      method: "resources/read",
      params: { uri: `vpg://workspaces/${workspaceId}/tree` },
    });
    const treeResourceBody = (await treeResource.json()) as {
      result?: { contents?: Array<{ text: string }> };
    };
    expect(treeResourceBody.result?.contents?.[0]?.text).toContain(pageId);

    const whoami = await tool("whoami", {});
    expect(whoami.user).toBeDefined();
    const workspaces = await tool("list_workspaces", {});
    expect(Array.isArray(workspaces.workspaces)).toBe(true);

    expect([...exercised].sort()).toEqual([...mcpToolNames].sort());
  });

  it("does not return invite magic-link verify URLs by default", async () => {
    const result = await callTool("invite_workspace_member", {
      workspace_id: "wks_demo",
      email: `mcp-invite-${crypto.randomUUID()}@example.com`,
      display_name: "MCP Invite",
      role: "reader",
    });

    expect(result.magic_link_created).toBe(true);
    expect(result.dev_verify_url).toBeNull();
    expect(JSON.stringify(result)).not.toContain(
      "/api/auth/magic-link/verify?token=",
    );
  });
});

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await post({
    jsonrpc: "2.0",
    id: `${name}-${Date.now()}`,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) throw new Error(body.error.message);
  return body.result?.structuredContent ?? {};
}

function post(body: unknown, headers: Record<string, string> = {}) {
  process.env.VPG_DEV_AUTO_LOGIN ??= "true";
  return POST({
    request: new Request("http://127.0.0.1:4322/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  } as never);
}
