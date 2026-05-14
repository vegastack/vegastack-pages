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
    expect(mcpToolNames).toContain("create_page");
    expect(mcpToolNames).toContain("wait_for_review");
    expect(mcpToolNames).toContain("prepare_page_edit");
    expect(mcpToolNames).toContain("patch_page");
    expect(mcpToolNames).toContain("validate_page_source");
    expect(mcpToolNames).toContain("complete_review_thread");
    expect(mcpToolNames).toContain("create_comment");
    expect(mcpToolNames).toContain("update_comment_anchor");
    expect(mcpToolNames).toContain("publish_page");
    expect(mcpToolNames).toContain("update_publication");
    expect(isMcpToolName("delete_everything")).toBe(false);
  });

  it("exposes MCP tool specs and JSON-RPC helpers", () => {
    expect(
      mcpToolSpecs.find((tool) => tool.name === "create_page")?.inputSchema
        .required,
    ).toContain("source");
    expect(jsonRpcResult(1, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    expect(jsonRpcError(1, -32601, "Nope").error.code).toBe(-32601);
  });

  it("requires workspace_id on every tool schema", () => {
    for (const tool of mcpToolSpecs) {
      expect(tool.inputSchema.required).toContain("workspace_id");
      expect(tool.inputSchema.properties).toHaveProperty("workspace_id");
    }
  });
});
