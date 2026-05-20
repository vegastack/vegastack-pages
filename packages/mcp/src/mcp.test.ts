import { describe, expect, it } from "vitest";
import {
  isMcpToolName,
  jsonRpcError,
  jsonRpcResult,
  mcpToolNames,
  mcpToolSpecs,
} from ".";

describe("mcp tool registry", () => {
  it("keeps agreed tool names stable", () => {
    // The post-refactor 22-tool surface (Notion-style verb_noun +
    // mega-fetch). Bumped from 19 → 22 when the trash/restore/list_trash
    // triple landed.
    expect(mcpToolNames).toContain("fetch");
    expect(mcpToolNames).toContain("search");
    expect(mcpToolNames).toContain("wait_for_review");
    expect(mcpToolNames).toContain("whoami");
    expect(mcpToolNames).toContain("create_page");
    expect(mcpToolNames).toContain("update_page");
    expect(mcpToolNames).toContain("restore_page_version");
    expect(mcpToolNames).toContain("move_page");
    expect(mcpToolNames).toContain("delete_page");
    expect(mcpToolNames).toContain("restore_page");
    expect(mcpToolNames).toContain("list_trash");
    expect(mcpToolNames).toContain("create_comment");
    expect(mcpToolNames).toContain("update_thread");
    expect(mcpToolNames).toContain("delete_thread");
    expect(mcpToolNames).toContain("apply_publication");
    expect(mcpToolNames).toContain("delete_publication");
    expect(mcpToolNames).toContain("create_template");
    expect(mcpToolNames).toContain("update_template");
    expect(mcpToolNames).toContain("render_template");
    expect(mcpToolNames).toContain("upload_attachment");
    expect(mcpToolNames).toContain("invite_workspace_member");
    expect(mcpToolNames).toContain("validate_page_source");

    // Removed legacy names must NOT be in the surface.
    expect(isMcpToolName("prepare_page_edit")).toBe(false);
    expect(isMcpToolName("patch_page")).toBe(false);
    expect(isMcpToolName("create_page_snapshot")).toBe(false);
    expect(isMcpToolName("get_page")).toBe(false);
    expect(isMcpToolName("list_comments")).toBe(false);
    expect(isMcpToolName("list_workspace")).toBe(false);
    expect(isMcpToolName("list_workspaces")).toBe(false);
    expect(isMcpToolName("list_review_events")).toBe(false);
    expect(isMcpToolName("list_templates")).toBe(false);
    expect(isMcpToolName("get_template")).toBe(false);
    expect(isMcpToolName("update_comment_anchor")).toBe(false);
    expect(isMcpToolName("publication_apply")).toBe(false);
    expect(isMcpToolName("publication_delete")).toBe(false);
    expect(isMcpToolName("search_workspace")).toBe(false);
    expect(isMcpToolName("create_page_from_template")).toBe(false);
    expect(isMcpToolName("delete_everything")).toBe(false);
  });

  it("exposes MCP tool specs and JSON-RPC helpers", () => {
    expect(
      mcpToolSpecs.find((tool) => tool.name === "create_page")?.inputSchema
        .required,
    ).toContain("title");
    expect(
      mcpToolSpecs.find((tool) => tool.name === "update_page")?.inputSchema
        .required,
    ).toContain("base_version_id");
    expect(
      mcpToolSpecs.find((tool) => tool.name === "fetch")?.inputSchema.required,
    ).toContain("workspace_id");
    expect(jsonRpcResult(1, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    expect(jsonRpcError(1, -32601, "Nope").error.code).toBe(-32601);
  });

  it("requires workspace_id on every workspace-scoped tool schema", () => {
    const sessionScopedTools = new Set(["whoami"]);
    for (const tool of mcpToolSpecs) {
      if (sessionScopedTools.has(tool.name)) continue;
      expect(tool.inputSchema.required).toContain("workspace_id");
      expect(tool.inputSchema.properties).toHaveProperty("workspace_id");
    }
  });

  it("ships exactly the agreed 22-tool surface", () => {
    expect(mcpToolNames.length).toBe(22);
    expect(mcpToolSpecs.length).toBe(22);
  });
});
